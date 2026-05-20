from typing import Literal, Optional

from pydantic import BaseModel

EventType = Literal[
    "task_started",
    "worker_running",
    "worker_chunk",
    "worker_usage",
    "tool_call",
    "human_input_required",
    "task_complete",
    "error",
]

# The four roles, in pipeline order. Used by both the runner and the frontend.
ROLES = ["researcher", "analyst", "critic", "summarizer"]


class RunEvent(BaseModel):
    """One server-sent event in a run's lifecycle.

    Mirrors the typed step events an Eigent-style frontend consumes: a type,
    the role it concerns, and a payload. Optional fields carry usage and
    tool-call info; consumers read only the fields relevant to each event type.
    """

    type: EventType
    role: Optional[str] = None
    text: str = ""
    mode: Optional[str] = None  # "delta" or "accumulate", for worker_chunk
    memo: Optional[str] = None
    # worker_usage:
    prompt_tokens: Optional[int] = None  # cumulative for this worker
    completion_tokens: Optional[int] = None  # cumulative for this worker
    cost: Optional[float] = None  # cumulative for this worker, USD
    # tool_call:
    tool_name: Optional[str] = None
    tool_query: Optional[str] = None
    # tool_call (vector retrieval): top retrieved sources, if any
    retrieved_sources: Optional[list[dict]] = None
    # tool_call (graph retrieval): top retrieved entities + their 1-hop edges
    retrieved_entities: Optional[list[dict]] = None
    # human_input_required: agent-initiated mid-run question
    question: Optional[str] = None
    choices: Optional[list[str]] = None
    request_id: Optional[str] = None
