"""Standalone OpenAI cache probe — bypasses CAMEL.

Sends two streamed chat completions back-to-back with an identical ~1500-token
system prompt and prints the usage dict each time. If the second call returns
cached_tokens > 0, OpenAI's prefix cache is working with our request shape; if
it returns 0, the issue is in the request structure (not in CAMEL).
"""

import json
import os
import sys

from openai import OpenAI


# Build a system prompt > 1024 tokens so the cache prefix qualifies.
SYSTEM_PROMPT = (
    "You are a clinical health researcher. "
    "Your job is to identify evidence-based interventions for the user's specific "
    "health profile, prioritizing safety and conservative recommendations. "
    "When the profile mentions any condition you must cite at least 3 recent "
    "guidelines or reviews from reputable sources (NIH, WHO, Mayo Clinic, "
    "peer-reviewed journals). Always disclose study limitations. Avoid "
    "supplements with strong drug interactions unless the profile explicitly "
    "notes that no medications are taken. Prefer lifestyle interventions over "
    "pharmacological ones for low-grade conditions. Structure your response as "
    "## Reasoning followed by ## Conclusion. Each Conclusion section must "
    "include at least: (1) the top 3 interventions, (2) their expected effect "
    "size, (3) any contraindications you flagged, (4) at least one open "
    "question you'd want a human to clarify before final write-up. "
) * 8  # ~ multiplied to push token count well past 1024

USER_PROMPT = "Profile: 28-year-old, generally healthy, wants to start running 3x/week."


def run_once(client: OpenAI, label: str) -> dict:
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT},
        ],
        temperature=0.2,
        stream=True,
        stream_options={"include_usage": True},
    )
    usage = None
    for chunk in resp:
        if chunk.usage is not None:
            usage = chunk.usage
    if usage is None:
        print(f"[{label}] NO USAGE RETURNED")
        return {}
    dumped = usage.model_dump()
    print(f"[{label}] usage = {json.dumps(dumped, indent=2)}")
    return dumped


def main() -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY not set", file=sys.stderr)
        return 1
    client = OpenAI()
    print(f"system prompt char-length: {len(SYSTEM_PROMPT)}")

    u1 = run_once(client, "RUN 1 (cold)")
    u2 = run_once(client, "RUN 2 (warm)")

    cached1 = (u1.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    cached2 = (u2.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    print(f"\ncached: run1={cached1}  run2={cached2}")
    print(f"prompt: run1={u1.get('prompt_tokens')}  run2={u2.get('prompt_tokens')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
