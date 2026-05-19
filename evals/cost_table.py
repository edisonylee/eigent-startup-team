"""Instrumented run — prints a per-worker token / cost / latency table.

Builds the four agents with an `on_request_usage` callback pinned to each, so
every API call's usage flows into a per-worker bucket. Runs one full Workforce
pipeline, then prints a markdown table for the README.

Run:  uv run python -m evals.cost_table
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any, Callable, Dict

from dotenv import load_dotenv

from camel.agents import ChatAgent
from camel.models import ModelFactory
from camel.societies.workforce import Workforce
from camel.tasks import Task
from camel.toolkits import FunctionTool, SearchToolkit
from camel.types import ModelPlatformType, ModelType

from src.agents import (
    ASSESSOR_PROMPT,
    PLAN_PROMPT,
    RESEARCHER_PROMPT,
    SAFETY_PROMPT,
)

# GPT-4o pricing (USD / 1M tokens), early 2026. Update if Anthropic/OpenAI rates change.
INPUT_PER_M = 2.50
OUTPUT_PER_M = 10.00

PROFILE = "34, software engineer, sit all day, want more energy and to lose 10 lbs, mild back pain, sleep about 6 hours"


def _model():
    return ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI,
        model_type=ModelType.GPT_4O,
        model_config_dict={"temperature": 0.2},
    )


def _agent(prompt: str, on_usage: Callable[[Dict[str, Any]], None], tools=None) -> ChatAgent:
    return ChatAgent(
        system_message=prompt,
        model=_model(),
        tools=tools,
        on_request_usage=on_usage,
    )


def _make_bucket(name: str, totals: dict[str, dict[str, int]]):
    def cb(payload: Dict[str, Any]) -> None:
        u = payload.get("request_usage", {})
        b = totals[name]
        b["requests"] += 1
        b["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
        b["completion_tokens"] += int(u.get("completion_tokens") or 0)
        b["total_tokens"] += int(u.get("total_tokens") or 0)

    return cb


def main() -> int:
    load_dotenv()

    totals: dict[str, dict[str, int]] = defaultdict(
        lambda: {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    )

    search_tool = FunctionTool(SearchToolkit().search_duckduckgo)
    researcher = _agent(RESEARCHER_PROMPT, _make_bucket("Health Researcher", totals), [search_tool])
    assessor = _agent(ASSESSOR_PROMPT, _make_bucket("Health Assessor", totals))
    reviewer = _agent(SAFETY_PROMPT, _make_bucket("Safety Reviewer", totals))
    writer = _agent(PLAN_PROMPT, _make_bucket("Plan Writer", totals))

    wf = Workforce("Personalized health team — instrumented")
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

    task = Task(
        content=(
            "Produce a structured personalized health plan for this person. "
            "Research evidence-based guidance, assess their focus areas, "
            "review the plan for safety, and write the final plan.\n\n"
            f"Profile: {PROFILE}"
        ),
        id="root",
    )

    print(f"profile: {PROFILE}\n")
    t0 = time.time()
    wf.process_task(task)
    wall = time.time() - t0

    # Coordinator + task-planner usage isn't captured (we don't own those
    # agents). We report what we measured: the four named workers.

    rows = []
    grand = {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0}
    order = ["Health Researcher", "Health Assessor", "Safety Reviewer", "Plan Writer"]
    for name in order:
        b = totals[name]
        cost = b["prompt_tokens"] * INPUT_PER_M / 1_000_000 + b["completion_tokens"] * OUTPUT_PER_M / 1_000_000
        rows.append((name, b["requests"], b["prompt_tokens"], b["completion_tokens"], cost))
        grand["requests"] += b["requests"]
        grand["prompt_tokens"] += b["prompt_tokens"]
        grand["completion_tokens"] += b["completion_tokens"]
        grand["cost"] += cost

    # Markdown table
    print("| Worker | Requests | Input tok | Output tok | Cost (USD) |")
    print("|---|---:|---:|---:|---:|")
    for name, req, pt, ct, cost in rows:
        print(f"| {name} | {req} | {pt:,} | {ct:,} | ${cost:.4f} |")
    print(
        f"| **Total** | **{grand['requests']}** | **{grand['prompt_tokens']:,}** | "
        f"**{grand['completion_tokens']:,}** | **${grand['cost']:.4f}** |"
    )
    print(f"\nWall time: **{wall:.1f}s**")
    print(
        "\n_Note: usage from the Workforce coordinator + task-planner agents "
        "is not captured here — those use CAMEL's default agents. The numbers "
        "above are the four named workers only._"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
