"""FastAPI app: starts Workforce runs, streams progress over SSE, and serves
the built React frontend as a single deployable service.
"""

import io
import os
import pathlib
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pypdf import PdfReader
from sse_starlette.sse import EventSourceResponse

from src.agents import (
    ASSESSOR_PROMPT,
    PLAN_PROMPT,
    RESEARCHER_PROMPT,
    SAFETY_PROMPT,
)
from src.lab_parser import parse_labs

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

app = FastAPI(title="Eigent Personalized Health Team")

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
