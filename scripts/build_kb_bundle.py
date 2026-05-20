"""Snapshot the user's ingested Chroma KB into `data/health_kb_chroma/`.

Once a maintainer has run `uv run python -m scripts.ingest_kb` and is
happy with the result, this script copies the ingested vector store into
the repo so first-launch installs can use it without re-running Firecrawl.

The shipped snapshot is what `src/rag.py:_maybe_seed_from_bundle` looks
for on first launch — it copies the bundle into `~/.healthos/vector/`
once the user data dir is empty.

Workflow for the KB maintainer:

    # 1. ingest sources
    uv run python -m scripts.ingest_kb

    # 2. spot-check retrieval quality
    uv run python -c "from src.rag import search_health_kb; \\
        print(search_health_kb('vitamin d adults', k=3))"

    # 3. snapshot into the repo
    uv run python -m scripts.build_kb_bundle

    # 4. commit data/health_kb_chroma/

Run:  uv run python -m scripts.build_kb_bundle
"""

from __future__ import annotations

import pathlib
import shutil
import sys

from src.rag import _vector_dir


def main() -> int:
    src = _vector_dir()
    if not any(src.iterdir()):
        print(f"nothing to bundle — {src} is empty", file=sys.stderr)
        print("run `uv run python -m scripts.ingest_kb` first.", file=sys.stderr)
        return 2

    dst = pathlib.Path(__file__).resolve().parent.parent / "data" / "health_kb_chroma"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    total = 0
    for child in src.iterdir():
        target = dst / child.name
        if child.is_dir():
            shutil.copytree(child, target)
            total += sum(1 for _ in target.rglob("*") if _.is_file())
        else:
            shutil.copy2(child, target)
            total += 1
    size_mb = sum(p.stat().st_size for p in dst.rglob("*") if p.is_file()) / (1024 * 1024)

    print(f"snapshotted {src}")
    print(f"  → {dst}")
    print(f"  files: {total}, total size: {size_mb:.1f} MB")
    print("\nCommit data/health_kb_chroma/ to include this in the next install.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
