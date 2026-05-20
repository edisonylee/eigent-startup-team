"""FastAPI app: starts Workforce runs, streams progress over SSE, and serves
the built React frontend as a single deployable service.
"""

import csv
import io
import os
import pathlib
import shutil
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pypdf import PdfReader
from sse_starlette.sse import EventSourceResponse

from . import db
from .mcp_manager import get_manager as get_mcp_manager

from src.agents import (
    ASSESSOR_PROMPT,
    PLAN_PROMPT,
    RESEARCHER_PROMPT,
    SAFETY_PROMPT,
)
from src.lab_parser import parse_labs
from src.model_config import (
    ModelBackend,
    ModelConfig,
    get_active_config,
    probe_status,
    set_active_config,
)

from .runner import (
    event_stream,
    rate_limited,
    resolve_question,
    start_follow_up,
    start_run,
)

# Local dev reads .env; in production (Render) the vars are set directly.
load_dotenv()

APP_PASSWORD = os.environ.get("APP_PASSWORD", "dev")


# Setting keys persisted in the `setting` table.
_SK_BACKEND = "model.backend"
_SK_OPENAI_MODEL = "model.openai_model"
_SK_OLLAMA_MODEL = "model.ollama_model"
_SK_OLLAMA_HOST = "model.ollama_host"


async def _hydrate_model_config() -> None:
    """Load model settings from SQLite into the active in-memory config."""
    backend = await db.get_setting(_SK_BACKEND)
    if backend is None:
        return
    current = get_active_config()
    try:
        new = ModelConfig(
            backend=ModelBackend(backend),
            openai_model=(await db.get_setting(_SK_OPENAI_MODEL)) or current.openai_model,
            ollama_model=(await db.get_setting(_SK_OLLAMA_MODEL)) or current.ollama_model,
            ollama_host=(await db.get_setting(_SK_OLLAMA_HOST)) or current.ollama_host,
        )
        set_active_config(new)
    except ValueError:
        pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.init_schema()
    await _hydrate_model_config()
    mcp = get_mcp_manager()
    await mcp.startup()
    try:
        yield
    finally:
        await mcp.shutdown()


app = FastAPI(title="Eigent Personalized Health Team", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    idea: str
    password: str
    biomarkers: Optional[list[dict]] = None


class AnswerRequest(BaseModel):
    request_id: str
    answer: str
    password: str


class FollowUpRequest(BaseModel):
    note: str
    password: str


class ModelSettingsRequest(BaseModel):
    password: str
    backend: str
    openai_model: Optional[str] = None
    ollama_model: Optional[str] = None
    ollama_host: Optional[str] = None


@app.post("/api/run")
async def run(req: RunRequest) -> dict:
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    if not req.idea.strip():
        raise HTTPException(status_code=400, detail="Idea is empty.")
    if rate_limited():
        raise HTTPException(
            status_code=429, detail="Hourly run limit reached. Try again later."
        )
    return {"task_id": start_run(req.idea.strip(), req.biomarkers)}


@app.post("/api/run/{task_id}/answer")
async def answer(task_id: str, req: AnswerRequest) -> dict:
    """Resolve an agent-initiated `request_human_input` question.

    The `task_id` path arg is currently only used for logging/auth grouping;
    request_ids are globally unique. Kept in the path for symmetry with the
    other run endpoints and to leave room for per-task auth in the future.
    """
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    if not resolve_question(req.request_id, req.answer):
        raise HTTPException(
            status_code=404,
            detail="No pending question with that id (already answered or timed out).",
        )
    return {"ok": True}


@app.post("/api/run/{task_id}/follow_up")
async def follow_up(task_id: str, req: FollowUpRequest) -> dict:
    """Refine an approved plan with additional context, without re-running
    the full Workforce. Runs Safety Reviewer + Plan Writer only."""
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    if not req.note.strip():
        raise HTTPException(status_code=400, detail="Note is empty.")
    if rate_limited():
        raise HTTPException(
            status_code=429, detail="Hourly run limit reached. Try again later."
        )
    try:
        new_task_id = start_follow_up(task_id, req.note.strip())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"task_id": new_task_id}


@app.post("/api/labs")
async def labs(
    password: str = Form(...),
    text: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
) -> dict:
    """Parse a lab report (PDF upload or pasted text) into a BiomarkerPanel."""
    if password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")

    extracted = (text or "").strip()
    if not extracted and file is not None:
        data = await file.read()
        try:
            reader = PdfReader(io.BytesIO(data))
            extracted = "\n\n".join(
                (page.extract_text() or "") for page in reader.pages
            ).strip()
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Could not read PDF: {type(exc).__name__}: {exc}",
            )

    if not extracted:
        raise HTTPException(
            status_code=400, detail="Provide a PDF file or pasted lab text."
        )

    panel = parse_labs(extracted)
    return panel.model_dump()


@app.get("/api/run/{task_id}/events")
async def events(task_id: str) -> EventSourceResponse:
    return EventSourceResponse(event_stream(task_id))


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/model/status")
def model_status() -> dict:
    """Active backend + probed availability. Drives the onboarding modal + settings UI."""
    return probe_status()


@app.post("/api/model/settings")
async def model_settings(req: ModelSettingsRequest) -> dict:
    """Hot-swap the active model config + persist to SQLite."""
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    try:
        backend = ModelBackend(req.backend)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Unknown backend: {req.backend}")

    current = get_active_config()
    new = ModelConfig(
        backend=backend,
        openai_model=req.openai_model or current.openai_model,
        ollama_model=req.ollama_model or current.ollama_model,
        ollama_host=req.ollama_host or current.ollama_host,
    )
    set_active_config(new)
    await db.set_setting(_SK_BACKEND, new.backend.value)
    await db.set_setting(_SK_OPENAI_MODEL, new.openai_model)
    await db.set_setting(_SK_OLLAMA_MODEL, new.ollama_model)
    await db.set_setting(_SK_OLLAMA_HOST, new.ollama_host)
    return probe_status()


# --- run history + timeline ---------------------------------------------------


@app.get("/api/runs")
async def runs(limit: int = 20) -> dict:
    return {"runs": await db.list_runs(limit)}


@app.get("/api/runs/{task_id}")
async def run_detail(task_id: str) -> dict:
    row = await db.get_run(task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return row


@app.get("/api/runs/{task_id}/timeline")
async def run_timeline(task_id: str) -> dict:
    row = await db.get_run(task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return {"task_id": task_id, "events": await db.get_timeline(task_id)}


# --- profile ------------------------------------------------------------------


class ProfileRequest(BaseModel):
    password: str
    name: Optional[str] = None
    dob: Optional[str] = None
    sex: Optional[str] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None
    notes: Optional[str] = None


@app.get("/api/profile")
async def profile_get() -> dict:
    p = await db.get_profile()
    return p or {}


@app.post("/api/profile")
async def profile_post(req: ProfileRequest) -> dict:
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    data = req.model_dump(exclude={"password"}, exclude_none=True)
    return await db.upsert_profile(data)


# --- check-ins ----------------------------------------------------------------


class CheckInRequest(BaseModel):
    password: str
    day: Optional[str] = None
    energy: Optional[int] = None
    sleep_hours: Optional[float] = None
    mood: Optional[int] = None
    adherence_notes: Optional[str] = None


# --- MCP servers --------------------------------------------------------------


class MCPReconnectRequest(BaseModel):
    password: str


@app.get("/api/mcp/servers")
def mcp_servers() -> dict:
    return {"servers": get_mcp_manager().status()}


@app.post("/api/mcp/servers/{name}/reconnect")
async def mcp_reconnect(name: str, req: MCPReconnectRequest) -> dict:
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    mgr = get_mcp_manager()
    try:
        await mgr.reconnect(name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown MCP server: {name}")
    return {"servers": mgr.status()}


@app.get("/api/evals")
def evals_dashboard() -> dict:
    """Read evals/results.csv into a tabular response with per-criterion means."""
    path = pathlib.Path(__file__).resolve().parent.parent / "evals" / "results.csv"
    rows: list[dict] = []
    if path.exists():
        with path.open() as f:
            reader = csv.DictReader(f)
            for row in reader:
                def _i(k: str) -> int:
                    try:
                        return int(row.get(k) or 0)
                    except ValueError:
                        return 0
                rows.append(
                    {
                        "ts": row.get("timestamp") or "",
                        "profile": row.get("profile") or "",
                        "coherence": _i("coherence"),
                        "actionability": _i("actionability"),
                        "safety": _i("safety"),
                        "personalization": _i("personalization"),
                        "one_line_summary": row.get("summary") or "",
                    }
                )
    criteria = ("coherence", "actionability", "safety", "personalization")
    means: dict[str, float] = {}
    if rows:
        for c in criteria:
            means[c] = sum(r[c] for r in rows) / len(rows)
    else:
        means = {c: 0.0 for c in criteria}
    return {"rows": rows, "means": means}


# --- data export / wipe -------------------------------------------------------


class WipeRequest(BaseModel):
    password: str
    confirm: str  # must equal "WIPE" to proceed


@app.get("/api/data/export")
def data_export(password: str) -> FileResponse:
    """Download the SQLite DB. Vector dir + notes are excluded — they're
    derivable (re-ingestable) and large.
    """
    if password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    path = db.db_path()
    if not path.exists():
        raise HTTPException(status_code=404, detail="No DB to export yet.")
    return FileResponse(
        path=str(path),
        media_type="application/octet-stream",
        filename="healthos.db",
    )


@app.post("/api/data/wipe")
def data_wipe(req: WipeRequest) -> dict:
    """Delete all local data. Requires confirm='WIPE'. Restart server to
    reinitialize the schema (the lifespan also does this on next boot).
    """
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    if req.confirm != "WIPE":
        raise HTTPException(
            status_code=400,
            detail="Set `confirm` to 'WIPE' to proceed — this is destructive.",
        )

    data_dir = db.db_path().parent
    deleted: list[str] = []
    for child in data_dir.iterdir():
        try:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
            deleted.append(child.name)
        except Exception:
            continue

    # Recreate the empty schema so the next request doesn't 500.
    db.init_schema_sync()
    return {"ok": True, "deleted": deleted}


@app.get("/api/check_ins")
async def check_ins_get(limit: int = 30) -> dict:
    return {"check_ins": await db.list_check_ins(limit)}


@app.post("/api/check_ins")
async def check_ins_post(req: CheckInRequest) -> dict:
    if req.password != APP_PASSWORD:
        raise HTTPException(status_code=401, detail="Wrong password.")
    data = req.model_dump(exclude={"password"}, exclude_none=True)
    return await db.add_check_in(data)


@app.get("/api/prompts")
def prompts() -> dict:
    """The system prompts for each worker — surfaced in the UI's expand-drawer
    so the user can see exactly what each agent was told to do."""
    return {
        "researcher": RESEARCHER_PROMPT,
        "analyst": ASSESSOR_PROMPT,
        "critic": SAFETY_PROMPT,
        "summarizer": PLAN_PROMPT,
    }


# Serve the built frontend (only present in the Docker image / after a build).
_DIST = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
