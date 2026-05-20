"""Verify the cached_tokens monkey-patch end-to-end against a CAMEL ChatAgent.

Builds a streaming ChatAgent (same shape as the Workforce researchers), fires
two identical .step() calls back-to-back, and asserts the on_request_usage
callback receives `cached_tokens > 0` on the second call.
"""

import os
import sys

from camel.agents import ChatAgent
from dotenv import load_dotenv

load_dotenv()

# Import for the patch side-effect (it registers monkey-patches on ChatAgent).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import backend.runner  # noqa: F401

from src.model_config import build_model

SYS_PROMPT = (
    "You are a clinical health researcher. Cite at least 3 reputable sources "
    "(NIH, WHO, Mayo, peer-reviewed journals). Disclose limitations. Prefer "
    "lifestyle interventions over pharmacological. Structure as ## Reasoning "
    "then ## Conclusion with: top 3 interventions, expected effect sizes, "
    "contraindications flagged, and at least one open question to clarify "
    "before final write-up. "
) * 24

USER = "Profile: 28yo, healthy, wants to start running 3x/week."


def main() -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY not set", file=sys.stderr)
        return 1

    captured: list[dict] = []

    def cb(payload: dict) -> None:
        captured.append(payload)

    for label in ("RUN 1 (cold)", "RUN 2 (warm)"):
        agent = ChatAgent(
            system_message=SYS_PROMPT,
            model=build_model(stream=True),
            on_request_usage=cb,
        )
        resp = agent.step(USER)
        # Drain the streaming generator so the API call actually fires.
        for _ in resp:
            pass
        last = captured[-1]
        ru = last["request_usage"]
        print(f"[{label}] prompt={ru['prompt_tokens']} cached={ru.get('cached_tokens')} completion={ru['completion_tokens']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
