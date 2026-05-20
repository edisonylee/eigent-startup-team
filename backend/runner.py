"""Runs a Workforce for the web UI and streams its progress as events.

Each run gets an asyncio.Queue. Two callbacks push events onto it:
  - the Workforce stream callback (token chunks per worker)
  - each ChatAgent's `on_request_usage` callback (per-request token usage)
A wrapped search tool also emits `tool_call` events when the Researcher hits
the web. All callbacks are thread-safe — they may fire from worker threads.
"""

import asyncio
import json
import re
import threading
import time
import uuid
from collections import defaultdict
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from camel.agents import ChatAgent
from camel.societies.workforce import Workforce
from camel.tasks import Task
from camel.toolkits import FunctionTool

from src.agents import (
    ASSESSOR_PROMPT,
    PLAN_PROMPT,
    RESEARCHER_PROMPT,
    SAFETY_PROMPT,
)
from src.model_config import build_model as _model
from src.model_config import get_active_config

from . import db
from .events import RunEvent
from .mcp_manager import get_manager

# task_id -> event queue. `None` on the queue is the close sentinel.
_queues: dict[str, asyncio.Queue] = {}

# request_id -> {event, slot, role} for in-flight agent-initiated questions.
# The agent's tool fn blocks on `event` until /answer endpoint fills `slot`
# and sets the event. Timeout is the agent's responsibility (it returns
# a sensible default if no answer arrives in time).
_pending_questions: dict[str, dict] = {}
_QUESTION_TIMEOUT_S = 300


# task_id -> the inputs + final memo of a completed-and-approved run.
# Used to enable cheap follow-up refinement without re-running the whole
# Workforce. In-memory only — survives the server process, not restarts.
class FinishedRun:
    __slots__ = ("profile", "biomarkers", "memo")

    def __init__(self, profile: str, biomarkers: List[dict], memo: str) -> None:
        self.profile = profile
        self.biomarkers = biomarkers
        self.memo = memo


_finished_runs: dict[str, FinishedRun] = {}

# Cheap global rate limit — protects the shared OpenAI key behind the gate.
_RUN_TIMES: list[float] = []
_MAX_RUNS_PER_HOUR = 20

# Pricing is sourced from the active model_config — Ollama returns 0.


def rate_limited() -> bool:
    now = time.time()
    _RUN_TIMES[:] = [t for t in _RUN_TIMES if now - t < 3600]
    if len(_RUN_TIMES) >= _MAX_RUNS_PER_HOUR:
        return True
    _RUN_TIMES.append(now)
    return False


_SUBTASK_MARKER = re.compile(r"-{2,}\s*Subtask\s+\S+\s+Result\s*-{2,}")
_CONCLUSION_MARKER = re.compile(r"^##\s+Conclusion\s*$", re.MULTILINE | re.IGNORECASE)


def _total_cost(totals: Dict[str, Dict[str, int]], cfg) -> float:
    """Sum cost across all workers using the active backend's pricing."""
    total = 0.0
    for b in totals.values():
        total += (
            b.get("prompt_tokens", 0) * cfg.input_cost_per_m / 1_000_000
            + b.get("completion_tokens", 0) * cfg.output_cost_per_m / 1_000_000
        )
    return total


def _strip_reasoning_prelude(text: str) -> str:
    """Drop everything up through a '## Conclusion' line.

    All four agents are prompted to output `## Reasoning` then `## Conclusion`.
    The final user-visible memo should only be the Conclusion content; the
    Reasoning trace is still preserved in the per-worker streamed output for
    the drawer to render.
    """
    m = _CONCLUSION_MARKER.search(text)
    if not m:
        return text
    return text[m.end():].lstrip()


def _extract_memo(raw: str) -> str:
    """Pull the clean memo out of a Workforce result.

    The Workforce sometimes returns the final summarizer memo directly, and
    sometimes a concatenation of every subtask result. In the latter case the
    last section is the Summarizer's output — that's the memo we want.
    Also strips the reasoning prelude so the user sees the polished plan.
    """
    raw = (raw or "").strip()
    if not raw:
        return "(no memo produced)"
    sections = [s.strip() for s in _SUBTASK_MARKER.split(raw) if s.strip()]
    memo = sections[-1] if sections else raw
    return _strip_reasoning_prelude(memo)


def _role_for(description: str) -> Optional[str]:
    d = description.lower()
    if "research" in d:
        return "researcher"
    if "assess" in d or "analy" in d:
        return "analyst"
    if "safety" in d or "review" in d:
        return "critic"
    if "plan" in d or "writ" in d or "summar" in d:
        return "summarizer"
    return None


def _parse_mcp_result(result: Any) -> list[dict]:
    """Pull JSON payload out of an MCP CallToolResult.

    Our health_kb server returns one TextContent with a JSON-serialized list.
    """
    try:
        content = getattr(result, "content", None) or []
        for c in content:
            text = getattr(c, "text", None)
            if not text:
                continue
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                continue
    except Exception:
        pass
    return []


def _make_question_tool(
    role: str,
    emit: Callable[[RunEvent], None],
) -> FunctionTool:
    """Build a `request_human_input` FunctionTool bound to a specific
    worker role. The tool blocks the worker thread on a threading.Event
    until the user's POST to /api/run/{id}/answer resolves it.

    The active `emit` is stashed on the pending-question record so
    `resolve_question` can fire a `human_input_answered` event back through
    the same SSE stream + DB log.
    """

    def request_human_input(question: str, choices: str = "") -> str:
        """Ask the user a clarifying question. Use SPARINGLY — ONLY when
        the answer would materially change your output. The user can
        always answer "use your best judgment" and you'll proceed with
        sensible defaults.

        Args:
            question: The clarifying question to ask the human.
            choices: Optional comma-separated list of multiple-choice
                options. If non-empty, the UI renders them as buttons.

        Returns:
            The user's answer as a string. Returns "use your best judgment"
            if the user doesn't respond within the timeout.
        """
        rid = uuid.uuid4().hex[:8]
        ev = threading.Event()
        slot = {"answer": "use your best judgment"}
        _pending_questions[rid] = {
            "event": ev,
            "slot": slot,
            "role": role,
            "question": question,
            "emit": emit,
        }

        opts: list[str] = [c.strip() for c in (choices or "").split(",") if c.strip()]

        emit(
            RunEvent(
                type="human_input_required",
                role=role,
                question=question,
                choices=opts,
                request_id=rid,
            )
        )

        ev.wait(timeout=_QUESTION_TIMEOUT_S)
        _pending_questions.pop(rid, None)
        return slot["answer"]

    return FunctionTool(request_human_input)


def _mcp_graph_tool(emit: Callable[[RunEvent], None]) -> FunctionTool:
    """Route query_health_graph through the health_kb MCP server."""

    def query_health_graph(query: str, k: int = 5) -> list[dict]:
        """query_health_graph — retrieves entities + 1-hop relationships.

        Args:
            query: Natural-language question or topic.
            k: Number of top entities to return (default 5).

        Returns:
            A list of entity dicts with typed edges.
        """
        result = get_manager().call_sync(
            "health_kb", "query_health_graph", {"query": query, "k": k}
        )
        entities = _parse_mcp_result(result)
        payload = [
            {
                "id": e.get("id"),
                "type": e.get("type"),
                "name": e.get("name"),
                "score": round(float(e.get("score") or 0), 4),
                "edge_count": len(e.get("edges") or []),
            }
            for e in entities
        ]
        emit(
            RunEvent(
                type="tool_call",
                role="researcher",
                tool_name="query_health_graph",
                tool_query=str(query),
                retrieved_entities=payload,
            )
        )
        return entities

    return FunctionTool(query_health_graph)


def _mcp_kb_tool(emit: Callable[[RunEvent], None]) -> FunctionTool:
    """Route search_health_kb through the health_kb MCP server."""

    def search_health_kb(query: str, k: int = 5) -> list[dict]:
        """search_health_kb — retrieves authoritative health-guideline chunks.

        Args:
            query: Natural-language question or topic.
            k: Number of chunks to return (default 5).

        Returns:
            A list of {text, source_url, title, score} dicts.
        """
        result = get_manager().call_sync(
            "health_kb", "search_health_kb", {"query": query, "k": k}
        )
        chunks = _parse_mcp_result(result)
        sources = [
            {
                "url": c.get("source_url") or "",
                "title": c.get("title") or "",
                "score": round(float(c.get("score") or 0), 4),
            }
            for c in chunks
        ]
        emit(
            RunEvent(
                type="tool_call",
                role="researcher",
                tool_name="search_health_kb",
                tool_query=str(query),
                retrieved_sources=sources,
            )
        )
        return chunks

    return FunctionTool(search_health_kb)


def _notes_dir_abs() -> str:
    """Same path the filesystem MCP server is rooted at."""
    import pathlib

    return str(
        (pathlib.Path.home() / ".healthos" / "notes").expanduser().resolve()
    )


def _mcp_list_notes_tool(emit: Callable[[RunEvent], None]) -> FunctionTool:
    """List files in ~/.healthos/notes/ via the filesystem MCP server."""

    def list_notes() -> list[str]:
        """list_notes — return filenames the user has dropped into the notes
        folder. Pair with `read_notes(filename)` to read one.

        Returns:
            A list of filenames (no paths). Empty list if the folder is empty.
        """
        result = get_manager().call_sync(
            "filesystem", "list_directory", {"path": _notes_dir_abs()}
        )
        emit(
            RunEvent(
                type="tool_call",
                role="researcher",
                tool_name="list_notes",
                tool_query="",
            )
        )
        out: list[str] = []
        for c in getattr(result, "content", None) or []:
            text = getattr(c, "text", None) or ""
            for line in text.splitlines():
                # filesystem MCP returns "[DIR] name" / "[FILE] name" rows.
                stripped = line.strip()
                if stripped.startswith("[FILE] "):
                    out.append(stripped[len("[FILE] ") :])
        return out

    return FunctionTool(list_notes)


def _mcp_read_notes_tool(emit: Callable[[RunEvent], None]) -> FunctionTool:
    """Read one file from ~/.healthos/notes/ via the filesystem MCP server."""

    import os

    def read_notes(filename: str) -> str:
        """read_notes — read the contents of a user-supplied note file.

        Args:
            filename: A filename inside the notes folder (no slashes). Get
                candidates from `list_notes()` first if you don't know the name.

        Returns:
            The file contents as a string, or an error string if not found.
        """
        if "/" in filename or filename.startswith(".."):
            return f"refused: invalid filename '{filename}'"
        path = os.path.join(_notes_dir_abs(), filename)
        result = get_manager().call_sync(
            "filesystem", "read_text_file", {"path": path}
        )
        emit(
            RunEvent(
                type="tool_call",
                role="researcher",
                tool_name="read_notes",
                tool_query=filename,
            )
        )
        text_parts: list[str] = []
        for c in getattr(result, "content", None) or []:
            t = getattr(c, "text", None)
            if t:
                text_parts.append(t)
        return "\n".join(text_parts) or f"empty: {filename}"

    return FunctionTool(read_notes)


def _mcp_brave_tool(emit: Callable[[RunEvent], None]) -> FunctionTool:
    """Route web search through the Brave MCP server (when enabled)."""

    def search_brave(query: str, count: int = 5) -> list[dict]:
        """search_brave — open-web search via the Brave MCP server.

        Args:
            query: The web search query.
            count: Number of results to return (default 5).

        Returns:
            A list of {title, url, description} dicts.
        """
        result = get_manager().call_sync(
            "brave_search", "brave_web_search", {"query": query, "count": count}
        )
        # Brave's text content is a human-readable bulleted list; surface it
        # as a single hit so the agent can quote from it.
        emit(
            RunEvent(
                type="tool_call",
                role="researcher",
                tool_name="search_brave",
                tool_query=str(query),
            )
        )
        out: list[dict] = []
        for c in getattr(result, "content", None) or []:
            text = getattr(c, "text", None)
            if text:
                out.append({"text": text})
        return out

    return FunctionTool(search_brave)


def _usage_callback(
    role: str,
    totals: Dict[str, Dict[str, int]],
    emit: Callable[[RunEvent], None],
) -> Callable[[Dict[str, Any]], None]:
    """Per-worker on_request_usage hook: accumulate tokens and emit cumulative usage."""

    def cb(payload: Dict[str, Any]) -> None:
        u = payload.get("request_usage", {}) or {}
        bucket = totals[role]
        bucket["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
        bucket["completion_tokens"] += int(u.get("completion_tokens") or 0)
        cfg = get_active_config()
        cost = (
            bucket["prompt_tokens"] * cfg.input_cost_per_m / 1_000_000
            + bucket["completion_tokens"] * cfg.output_cost_per_m / 1_000_000
        )
        emit(
            RunEvent(
                type="worker_usage",
                role=role,
                prompt_tokens=bucket["prompt_tokens"],
                completion_tokens=bucket["completion_tokens"],
                cost=cost,
            )
        )

    return cb


def _build_instrumented_workforce(
    emit: Callable[[RunEvent], None],
    totals: Dict[str, Dict[str, int]],
) -> Workforce:
    """Build the Workforce with usage callbacks pinned to each worker and
    MCP-routed retrieval/web tools. Brave is included only when its MCP
    server is connected (BRAVE_API_KEY set)."""
    manager = get_manager()
    researcher_tools = [
        _mcp_graph_tool(emit),
        _mcp_kb_tool(emit),
    ]
    if manager.is_connected("filesystem"):
        researcher_tools.append(_mcp_list_notes_tool(emit))
        researcher_tools.append(_mcp_read_notes_tool(emit))
    if manager.is_connected("brave_search"):
        researcher_tools.append(_mcp_brave_tool(emit))
    researcher_tools.append(_make_question_tool("researcher", emit))

    researcher = ChatAgent(
        system_message=RESEARCHER_PROMPT,
        model=_model(stream=True),
        tools=researcher_tools,
        on_request_usage=_usage_callback("researcher", totals, emit),
    )
    assessor = ChatAgent(
        system_message=ASSESSOR_PROMPT,
        model=_model(stream=True),
        tools=[_make_question_tool("analyst", emit)],
        on_request_usage=_usage_callback("analyst", totals, emit),
    )
    reviewer = ChatAgent(
        system_message=SAFETY_PROMPT,
        model=_model(stream=True),
        tools=[_make_question_tool("critic", emit)],
        on_request_usage=_usage_callback("critic", totals, emit),
    )
    writer = ChatAgent(
        system_message=PLAN_PROMPT,
        model=_model(stream=True),
        tools=[_make_question_tool("summarizer", emit)],
        on_request_usage=_usage_callback("summarizer", totals, emit),
    )

    wf = Workforce(
        "Personalized health team — turns a profile into a personalized health plan"
    )
    wf.add_single_agent_worker(
        "Health Researcher — gathers evidence-based, current health information "
        "using web search. Use for any subtask that needs facts from the web.",
        worker=researcher,
    )
    wf.add_single_agent_worker(
        "Health Assessor — analyzes the profile against the research and picks "
        "the highest-impact focus areas. Use for reasoning, not for gathering.",
        worker=assessor,
    )
    wf.add_single_agent_worker(
        "Safety Reviewer — reviews the plan for risks, contraindications, and "
        "red flags, then gives a safety verdict. Use to pressure-test the plan.",
        worker=reviewer,
    )
    wf.add_single_agent_worker(
        "Plan Writer — writes the final personalized health plan in markdown. "
        "Use last, to assemble everything into the deliverable.",
        worker=writer,
    )
    return wf


def start_run(idea: str, biomarkers: Optional[List[dict]] = None) -> str:
    """Schedule a Workforce run; return its task_id immediately."""
    task_id = uuid.uuid4().hex[:12]
    _queues[task_id] = asyncio.Queue()
    asyncio.create_task(_run(task_id, idea, biomarkers or []))
    return task_id


def resolve_question(request_id: str, answer: str) -> bool:
    """Fill the slot of a pending agent-initiated question. Returns False
    if the request_id is unknown (already answered, timed out, or never
    existed).

    Also fires a `human_input_answered` SSE event so the timeline view +
    DB log capture what the user said back. The current modal doesn't
    need this event (it dismisses on submit), so it's purely additive.
    """
    pending = _pending_questions.get(request_id)
    if pending is None or pending["event"].is_set():
        return False
    pending["slot"]["answer"] = answer
    pending["event"].set()

    emit = pending.get("emit")
    if emit is not None:
        emit(
            RunEvent(
                type="human_input_answered",
                role=pending.get("role"),
                request_id=request_id,
                question=pending.get("question"),
                answer=answer,
            )
        )
    return True


def _format_biomarkers(biomarkers: List[dict]) -> str:
    """Render biomarkers as a compact block for the root task content."""
    if not biomarkers:
        return ""
    lines = ["Lab values provided:"]
    for b in biomarkers:
        name = b.get("name") or "?"
        value = b.get("value") or "?"
        unit = b.get("unit") or ""
        ref = b.get("reference_range") or "-"
        flag = (b.get("flag") or "unknown").upper()
        flag_tag = "" if flag == "UNKNOWN" else f" [{flag}]"
        lines.append(f"  - {name}: {value} {unit} (ref {ref}){flag_tag}")
    return "\n".join(lines)


async def _run(task_id: str, idea: str, biomarkers: List[dict]) -> None:
    queue = _queues[task_id]
    loop = asyncio.get_running_loop()
    cfg = get_active_config()

    def emit(event: RunEvent) -> None:
        # Safe from any thread — callbacks may run off-loop.
        loop.call_soon_threadsafe(queue.put_nowait, event)
        db.append_event_threadsafe(
            task_id, event.type, event.role, event.model_dump(exclude_none=True)
        )

    try:
        db.create_run_sync(task_id, idea, cfg.backend.value)
        totals: Dict[str, Dict[str, int]] = defaultdict(
            lambda: {"prompt_tokens": 0, "completion_tokens": 0}
        )
        wf = _build_instrumented_workforce(emit, totals)

        id_to_role = {
            child.node_id: _role_for(child.description or "")
            for child in getattr(wf, "_children", [])
        }
        started: set[str] = set()

        def on_chunk(worker_id: str, _task_id: str, text: str, mode: str) -> None:
            role = id_to_role.get(worker_id)
            if role is None:
                return
            if role not in started:
                started.add(role)
                emit(RunEvent(type="worker_running", role=role))
            emit(RunEvent(type="worker_chunk", role=role, text=text, mode=mode))

        wf.set_stream_callback(on_chunk)

        emit(RunEvent(type="task_started"))

        biomarker_block = _format_biomarkers(biomarkers)
        profile_text = idea
        if biomarker_block:
            profile_text = f"{idea}\n\n{biomarker_block}"

        task = Task(
            content=(
                "Produce a structured personalized health plan for this "
                "person. Research evidence-based guidance, assess their focus "
                "areas, review the plan for safety, and write the final "
                f"plan.\n\nProfile: {profile_text}"
            ),
            id="root",
        )

        result = await wf.process_task_async(task)
        memo = _extract_memo(result.result)

        # HITL is now agent-initiated mid-run via request_human_input.
        # The plan is released as soon as the Workforce finishes.
        emit(RunEvent(type="task_complete", memo=memo))
        _finished_runs[task_id] = FinishedRun(
            profile=idea, biomarkers=biomarkers, memo=memo
        )
        db.finalize_run_sync(
            task_id, status="done", memo=memo, cost_usd=_total_cost(totals, cfg)
        )

    except Exception as exc:  # surface failures to the UI instead of hanging
        emit(RunEvent(type="error", text=f"{type(exc).__name__}: {exc}"))
        db.finalize_run_sync(task_id, status="error")
    finally:
        loop.call_soon_threadsafe(queue.put_nowait, None)


def start_follow_up(orig_task_id: str, note: str) -> str:
    """Schedule a 2-stage refinement (Safety Reviewer + Plan Writer) against a
    previously approved run. Returns the new task_id immediately.

    Hydrates `_finished_runs` from SQLite if needed — supports follow-ups
    on runs whose process was restarted since the original completed.
    """
    if orig_task_id not in _finished_runs:
        row = db.get_run_sync(orig_task_id)
        if row is None or row.get("status") != "done" or not row.get("memo"):
            raise ValueError("Unknown task id — original run not found.")
        _finished_runs[orig_task_id] = FinishedRun(
            profile=row.get("idea") or "",
            biomarkers=[],
            memo=row.get("memo") or "",
        )
    new_task_id = f"{orig_task_id}-f{uuid.uuid4().hex[:4]}"
    _queues[new_task_id] = asyncio.Queue()
    asyncio.create_task(_run_followup(new_task_id, orig_task_id, note))
    return new_task_id


async def _run_followup(new_task_id: str, orig_task_id: str, note: str) -> None:
    """Cheap revision flow: re-runs ONLY the Safety Reviewer and Plan Writer
    against the previous memo + a user-supplied addition. The Researcher and
    Assessor are intentionally skipped — their work is already encoded in the
    prior memo. Cost is ~1/10th of a full run."""
    queue = _queues[new_task_id]
    loop = asyncio.get_running_loop()
    cfg = get_active_config()

    def emit(event: RunEvent) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)
        db.append_event_threadsafe(
            new_task_id, event.type, event.role, event.model_dump(exclude_none=True)
        )

    try:
        prev = _finished_runs[orig_task_id]
        db.create_run_sync(new_task_id, f"follow-up of {orig_task_id}: {note}", cfg.backend.value)
        totals: Dict[str, Dict[str, int]] = defaultdict(
            lambda: {"prompt_tokens": 0, "completion_tokens": 0}
        )

        safety_agent = ChatAgent(
            system_message=SAFETY_PROMPT,
            model=_model(stream=False),
            tools=[_make_question_tool("critic", emit)],
            on_request_usage=_usage_callback("critic", totals, emit),
        )
        plan_agent = ChatAgent(
            system_message=PLAN_PROMPT,
            model=_model(stream=False),
            tools=[_make_question_tool("summarizer", emit)],
            on_request_usage=_usage_callback("summarizer", totals, emit),
        )

        emit(RunEvent(type="task_started"))

        biomarker_block = _format_biomarkers(prev.biomarkers)
        profile_summary = prev.profile + (
            f"\n\n{biomarker_block}" if biomarker_block else ""
        )

        # Stage 1: Safety re-review with the addition.
        emit(RunEvent(type="worker_running", role="critic"))
        safety_input = (
            f"Original profile:\n{profile_summary}\n\n"
            f"Original plan (already produced):\n{prev.memo}\n\n"
            f"The user is adding the following to their profile:\n"
            f'"{note}"\n\n'
            "Re-review the existing plan with this new context. Surface any "
            "new risks, contraindications, or red-flag symptoms the addition "
            "introduces, and update the verdict if warranted."
        )
        safety_resp = await asyncio.to_thread(safety_agent.step, safety_input)
        safety_text = safety_resp.msgs[0].content
        emit(
            RunEvent(
                type="worker_chunk",
                role="critic",
                text=safety_text,
                mode="accumulate",
            )
        )

        # Stage 2: Plan revision incorporating the addition.
        emit(RunEvent(type="worker_running", role="summarizer"))
        plan_input = (
            f"Original profile:\n{profile_summary}\n\n"
            f"Original plan (already produced):\n{prev.memo}\n\n"
            f"The user added:\n\"{note}\"\n\n"
            f"Updated safety review:\n{safety_text}\n\n"
            "Produce a REVISED plan that incorporates the addition. Keep the "
            "structure and most of the substance of the original plan; "
            "modify, remove, or add bullets ONLY where the new context "
            "warrants it. Keep the same section headers and the educational "
            "disclaimer."
        )
        plan_resp = await asyncio.to_thread(plan_agent.step, plan_input)
        plan_text = plan_resp.msgs[0].content
        emit(
            RunEvent(
                type="worker_chunk",
                role="summarizer",
                text=plan_text,
                mode="accumulate",
            )
        )

        new_memo = _strip_reasoning_prelude(plan_text)

        # No end-gate — HITL is agent-initiated during Safety/Plan steps
        # (the question tool fires inline when needed). Release on
        # natural completion.
        emit(RunEvent(type="task_complete", memo=new_memo))
        _finished_runs[new_task_id] = FinishedRun(
            profile=prev.profile,
            biomarkers=prev.biomarkers,
            memo=new_memo,
        )
        db.finalize_run_sync(
            new_task_id, status="done", memo=new_memo, cost_usd=_total_cost(totals, cfg)
        )

    except Exception as exc:
        emit(RunEvent(type="error", text=f"{type(exc).__name__}: {exc}"))
        db.finalize_run_sync(new_task_id, status="error")
    finally:
        loop.call_soon_threadsafe(queue.put_nowait, None)


async def event_stream(task_id: str) -> AsyncIterator[str]:
    """Yield SSE `data:` payloads for a run until it completes."""
    queue = _queues.get(task_id)
    if queue is None:
        yield RunEvent(type="error", text="unknown task id").model_dump_json()
        return
    try:
        while True:
            event = await queue.get()
            if event is None:
                return
            yield event.model_dump_json()
    finally:
        _queues.pop(task_id, None)
