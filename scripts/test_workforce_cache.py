"""End-to-end 2-run prompt-cache test via the live HTTP API.

POSTs /api/run twice with the same profile, listens to the SSE event stream
for each, accumulates the final worker_usage values, and prints the per-worker
cached_tokens / prompt_tokens / cost. Second run should show non-zero cache.
"""

import json
import os
import sys
import time
import urllib.request
from collections import defaultdict
from typing import Dict

from dotenv import load_dotenv

load_dotenv()

BASE = "http://localhost:8000"
PASSWORD = os.environ.get("APP_PASSWORD", "dev")
PROFILE = (
    "Profile: 28-year-old, generally healthy, "
    "wants to start running 3x/week and improve sleep."
)


def post_json(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def consume_run(task_id: str) -> Dict[str, Dict[str, int]]:
    """Connect to SSE stream and accumulate latest per-worker usage.

    Manual SSE parser: each event arrives as one or more `data: <json>` lines
    terminated by a blank line. We only care about `worker_usage` events;
    `task_complete` or `error` ends the stream.
    """
    url = f"{BASE}/api/run/{task_id}/events"
    resp = urllib.request.urlopen(url, timeout=300)
    per_worker: Dict[str, Dict[str, int]] = defaultdict(
        lambda: {"prompt": 0, "completion": 0, "cached": 0, "cost": 0.0}
    )
    buf: list[str] = []
    while True:
        raw = resp.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            if buf:
                data = "\n".join(s[6:] if s.startswith("data: ") else s for s in buf if s.startswith("data:"))
                buf.clear()
                if not data:
                    continue
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue
                t = payload.get("type")
                if t == "worker_usage":
                    role = payload.get("role", "?")
                    per_worker[role]["prompt"] = payload.get("prompt_tokens") or 0
                    per_worker[role]["completion"] = payload.get("completion_tokens") or 0
                    per_worker[role]["cached"] = payload.get("cached_tokens") or 0
                    per_worker[role]["cost"] = payload.get("cost") or 0.0
                elif t == "task_complete":
                    return dict(per_worker)
                elif t == "error":
                    print(f"  error: {payload.get('text')}", file=sys.stderr)
                    return dict(per_worker)
            continue
        buf.append(line)
    return dict(per_worker)


def report(label: str, totals: Dict[str, Dict[str, int]]) -> None:
    print(f"\n=== {label} ===")
    total_prompt = total_cached = total_cost = 0
    for role, b in sorted(totals.items()):
        prompt = b["prompt"]
        cached = b["cached"]
        cost = b["cost"]
        pct = round((cached / prompt) * 100) if prompt else 0
        print(f"  {role:<11} prompt={prompt:>6}  cached={cached:>6}  ({pct:>3}%)  cost=${cost:.4f}")
        total_prompt += prompt
        total_cached += cached
        total_cost += cost
    pct = round((total_cached / total_prompt) * 100) if total_prompt else 0
    print(f"  {'TOTAL':<11} prompt={total_prompt:>6}  cached={total_cached:>6}  ({pct:>3}%)  cost=${total_cost:.4f}")


def main() -> int:
    print(f"profile: {PROFILE!r}")
    print("starting run 1 (cold)...")
    r1 = post_json("/api/run", {"idea": PROFILE, "password": PASSWORD})
    task1 = r1["task_id"]
    print(f"  task_id={task1}")
    t1 = consume_run(task1)
    report("RUN 1 (cold)", t1)

    print("\nstarting run 2 (warm; should hit cache)...")
    r2 = post_json("/api/run", {"idea": PROFILE, "password": PASSWORD})
    task2 = r2["task_id"]
    print(f"  task_id={task2}")
    t2 = consume_run(task2)
    report("RUN 2 (warm)", t2)

    cached1 = sum(b["cached"] for b in t1.values())
    cached2 = sum(b["cached"] for b in t2.values())
    print(f"\nΔcached: {cached1} → {cached2}")
    return 0 if cached2 > cached1 else 1


if __name__ == "__main__":
    sys.exit(main())
