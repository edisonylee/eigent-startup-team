"""SQLite persistence for HealthOS.

Single local file at `~/.healthos/healthos.db` (override via `HEALTHOS_DB`).
Stdlib `sqlite3` wrapped in `asyncio.to_thread` to avoid a new dep.

Tables (created idempotently by `init_schema`):
  profile     — single row (multi-profile is a v3 problem).
  biomarker   — append-only history per profile.
  run         — one row per Workforce run; status ∈ running | done | error.
  run_event   — full SSE event log per run; powers the timeline view.
  check_in    — daily check-in entries (energy, sleep, mood, notes).
  setting     — key/value for model backend + MCP enable/disable.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sqlite3
import time
import uuid
from typing import Any, Optional


# Data dir: ~/.healthos/, override via HEALTHOS_DATA_DIR or HEALTHOS_DB.
def _data_dir() -> pathlib.Path:
    p = pathlib.Path(
        os.environ.get("HEALTHOS_DATA_DIR")
        or (pathlib.Path.home() / ".healthos")
    ).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> pathlib.Path:
    return pathlib.Path(os.environ.get("HEALTHOS_DB") or (_data_dir() / "healthos.db"))


SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (
    id            INTEGER PRIMARY KEY,
    name          TEXT,
    dob           TEXT,
    sex           TEXT,
    height_cm     REAL,
    weight_kg     REAL,
    notes         TEXT,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS biomarker (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id    INTEGER NOT NULL,
    name          TEXT NOT NULL,
    value         TEXT NOT NULL,
    unit          TEXT,
    ref_range     TEXT,
    flag          TEXT,
    recorded_at   REAL NOT NULL,
    FOREIGN KEY (profile_id) REFERENCES profile(id)
);

CREATE TABLE IF NOT EXISTS run (
    task_id        TEXT PRIMARY KEY,
    profile_id     INTEGER,
    started_at     REAL NOT NULL,
    ended_at       REAL,
    status         TEXT NOT NULL,
    idea           TEXT,
    memo           TEXT,
    cost_usd       REAL DEFAULT 0,
    model_backend  TEXT
);

CREATE TABLE IF NOT EXISTS run_event (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      TEXT NOT NULL,
    ts           REAL NOT NULL,
    kind         TEXT NOT NULL,
    role         TEXT,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES run(task_id)
);
CREATE INDEX IF NOT EXISTS idx_run_event_task ON run_event(task_id, ts);

CREATE TABLE IF NOT EXISTS check_in (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER,
    day             TEXT NOT NULL,
    energy          INTEGER,
    sleep_hours     REAL,
    mood            INTEGER,
    adherence_notes TEXT,
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_check_in_day ON check_in(day);

CREATE TABLE IF NOT EXISTS setting (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- v3: personal entities extracted from the user's data. Distinct from the
-- canonical health graph (in data/health_graph.yaml) — these are user-
-- specific (Dr. Smith, "the trip to Banff", "the magnesium I started in
-- May"). `canonical_id` optionally links to a canonical node when the
-- extraction matched, e.g. magnesium → canonical "magnesium".
CREATE TABLE IF NOT EXISTS personal_entity (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,                 -- nutrient | condition | provider |
                                                 -- medication | food | place |
                                                 -- person | activity | other
    canonical_id  TEXT,
    first_seen    REAL,
    last_seen     REAL,
    mention_count INTEGER DEFAULT 0,
    UNIQUE(name, type)
);

CREATE TABLE IF NOT EXISTS entity_mention (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id       INTEGER NOT NULL,
    source_kind     TEXT NOT NULL,               -- run_memo | check_in_note |
                                                 -- profile_note | lab_biomarker
    source_id       TEXT NOT NULL,
    context_snippet TEXT,
    ts              REAL NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES personal_entity(id)
);

CREATE INDEX IF NOT EXISTS idx_mention_entity ON entity_mention(entity_id);
CREATE INDEX IF NOT EXISTS idx_mention_source ON entity_mention(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_entity_type ON personal_entity(type);

-- v3: long-term operator substrate. Point events logged retroactively or
-- live. `day` is YYYY-MM-DD in user-local time (used by the calendar grid).
-- `ts` is the canonical epoch timestamp (used for ordering and trend math).
-- `tags_json` is an optional JSON array of strings. `meta_json` carries the
-- open-set fields (severity, dose, duration_min, source) without forcing
-- schema changes for every new event shape.
CREATE TABLE IF NOT EXISTS event (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id    INTEGER,
    ts            REAL NOT NULL,
    day           TEXT NOT NULL,
    category      TEXT NOT NULL,                 -- symptom | meal | sleep |
                                                 -- exercise | supplement |
                                                 -- medication | mood | note
    description   TEXT NOT NULL,
    tags_json     TEXT,
    meta_json     TEXT,
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_profile_day ON event(profile_id, day);
CREATE INDEX IF NOT EXISTS idx_event_ts ON event(ts);
CREATE INDEX IF NOT EXISTS idx_event_category ON event(category);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path()))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema_sync() -> None:
    """Create tables if missing. Safe to call repeatedly."""
    with _connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


async def init_schema() -> None:
    await asyncio.to_thread(init_schema_sync)


# --- settings -----------------------------------------------------------------


def get_setting_sync(key: str) -> Optional[str]:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM setting WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


def set_setting_sync(key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO setting(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()


async def get_setting(key: str) -> Optional[str]:
    return await asyncio.to_thread(get_setting_sync, key)


async def set_setting(key: str, value: str) -> None:
    await asyncio.to_thread(set_setting_sync, key, value)


# --- profile ------------------------------------------------------------------


def get_profile_sync() -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM profile LIMIT 1").fetchone()
        return dict(row) if row else None


def upsert_profile_sync(data: dict) -> dict:
    now = time.time()
    with _connect() as conn:
        existing = conn.execute("SELECT id FROM profile LIMIT 1").fetchone()
        if existing:
            conn.execute(
                "UPDATE profile SET name=?, dob=?, sex=?, height_cm=?, weight_kg=?, "
                "notes=?, updated_at=? WHERE id = ?",
                (
                    data.get("name"),
                    data.get("dob"),
                    data.get("sex"),
                    data.get("height_cm"),
                    data.get("weight_kg"),
                    data.get("notes"),
                    now,
                    existing["id"],
                ),
            )
            pid = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO profile(name, dob, sex, height_cm, weight_kg, notes, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    data.get("name"),
                    data.get("dob"),
                    data.get("sex"),
                    data.get("height_cm"),
                    data.get("weight_kg"),
                    data.get("notes"),
                    now,
                    now,
                ),
            )
            pid = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM profile WHERE id = ?", (pid,)).fetchone()
        return dict(row)


async def get_profile() -> Optional[dict]:
    return await asyncio.to_thread(get_profile_sync)


async def upsert_profile(data: dict) -> dict:
    return await asyncio.to_thread(upsert_profile_sync, data)


# --- runs ---------------------------------------------------------------------


def create_run_sync(
    task_id: str,
    idea: str,
    model_backend: str,
    profile_id: Optional[int] = None,
) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO run(task_id, profile_id, started_at, status, idea, model_backend) "
            "VALUES(?, ?, ?, 'running', ?, ?)",
            (task_id, profile_id, time.time(), idea, model_backend),
        )
        conn.commit()


def finalize_run_sync(
    task_id: str,
    status: str,
    memo: Optional[str] = None,
    cost_usd: Optional[float] = None,
) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE run SET ended_at = ?, status = ?, memo = COALESCE(?, memo), "
            "cost_usd = COALESCE(?, cost_usd) WHERE task_id = ?",
            (time.time(), status, memo, cost_usd, task_id),
        )
        conn.commit()


def list_runs_sync(limit: int = 20) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT task_id, started_at, ended_at, status, idea, memo, cost_usd, model_backend "
            "FROM run ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_run_sync(task_id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM run WHERE task_id = ?", (task_id,)).fetchone()
        return dict(row) if row else None


def append_event_sync(
    task_id: str,
    kind: str,
    role: Optional[str],
    payload: dict,
) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO run_event(task_id, ts, kind, role, payload_json) VALUES(?, ?, ?, ?, ?)",
            (task_id, time.time(), kind, role, json.dumps(payload, default=str)),
        )
        conn.commit()


def get_timeline_sync(task_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, ts, kind, role, payload_json FROM run_event "
            "WHERE task_id = ? ORDER BY ts, id",
            (task_id,),
        ).fetchall()
        out: list[dict] = []
        for r in rows:
            d = dict(r)
            try:
                d["payload"] = json.loads(d.pop("payload_json"))
            except json.JSONDecodeError:
                d["payload"] = {}
            out.append(d)
        return out


async def create_run(task_id: str, idea: str, model_backend: str) -> None:
    await asyncio.to_thread(create_run_sync, task_id, idea, model_backend)


async def finalize_run(
    task_id: str,
    status: str,
    memo: Optional[str] = None,
    cost_usd: Optional[float] = None,
) -> None:
    await asyncio.to_thread(finalize_run_sync, task_id, status, memo, cost_usd)


async def list_runs(limit: int = 20) -> list[dict]:
    return await asyncio.to_thread(list_runs_sync, limit)


async def get_run(task_id: str) -> Optional[dict]:
    return await asyncio.to_thread(get_run_sync, task_id)


async def get_timeline(task_id: str) -> list[dict]:
    return await asyncio.to_thread(get_timeline_sync, task_id)


def append_event_threadsafe(
    task_id: str, kind: str, role: Optional[str], payload: dict
) -> None:
    """Fire-and-forget event log, safe to call from worker threads.

    Used by the runner's `emit` callback which may fire off-loop. We don't
    block the event loop on this; we just persist on the calling thread.
    """
    try:
        append_event_sync(task_id, kind, role, payload)
    except Exception:
        # Persistence failures should never break a run.
        pass


# --- check-ins ----------------------------------------------------------------


def add_check_in_sync(data: dict) -> dict:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO check_in(profile_id, day, energy, sleep_hours, mood, "
            "adherence_notes, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
            (
                data.get("profile_id"),
                data.get("day") or time.strftime("%Y-%m-%d"),
                data.get("energy"),
                data.get("sleep_hours"),
                data.get("mood"),
                data.get("adherence_notes"),
                time.time(),
            ),
        )
        cid = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM check_in WHERE id = ?", (cid,)).fetchone()
        return dict(row)


def list_check_ins_sync(limit: int = 30) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM check_in ORDER BY day DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


async def add_check_in(data: dict) -> dict:
    return await asyncio.to_thread(add_check_in_sync, data)


async def list_check_ins(limit: int = 30) -> list[dict]:
    return await asyncio.to_thread(list_check_ins_sync, limit)


# --- biomarkers ---------------------------------------------------------------


def add_biomarkers_sync(
    profile_id: int, biomarkers: list[dict], recorded_at: Optional[float] = None
) -> list[int]:
    """Append a panel of parsed biomarker rows.

    `biomarkers` items are Pydantic `Biomarker`-shaped dicts (name, value,
    unit, reference_range, flag). The Pydantic field is `reference_range`
    but the SQL column is `ref_range` — translated here.
    Returns the new row ids so callers can trigger entity extraction.
    """
    ts = recorded_at if recorded_at is not None else time.time()
    ids: list[int] = []
    with _connect() as conn:
        for b in biomarkers:
            cur = conn.execute(
                "INSERT INTO biomarker(profile_id, name, value, unit, ref_range, "
                "flag, recorded_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    profile_id,
                    b.get("name"),
                    str(b.get("value", "")),
                    b.get("unit"),
                    b.get("reference_range") or b.get("ref_range"),
                    b.get("flag") or "unknown",
                    ts,
                ),
            )
            ids.append(cur.lastrowid)
        conn.commit()
    return ids


def list_recent_biomarkers_sync(limit: int = 60) -> list[dict]:
    """Latest row per biomarker name, newest panel first."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT b.id, b.name, b.value, b.unit, b.ref_range, b.flag, b.recorded_at
            FROM biomarker b
            JOIN (
                SELECT name, MAX(recorded_at) AS mx
                FROM biomarker GROUP BY name
            ) latest
              ON latest.name = b.name AND latest.mx = b.recorded_at
            ORDER BY b.recorded_at DESC, b.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


async def add_biomarkers(
    profile_id: int, biomarkers: list[dict], recorded_at: Optional[float] = None
) -> list[int]:
    return await asyncio.to_thread(
        add_biomarkers_sync, profile_id, biomarkers, recorded_at
    )


async def list_recent_biomarkers(limit: int = 60) -> list[dict]:
    return await asyncio.to_thread(list_recent_biomarkers_sync, limit)


# --- events -------------------------------------------------------------------


def _event_row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in ("tags_json", "meta_json"):
        raw = d.pop(k)
        out_key = k.removesuffix("_json")
        if not raw:
            d[out_key] = [] if k == "tags_json" else {}
            continue
        try:
            d[out_key] = json.loads(raw)
        except json.JSONDecodeError:
            d[out_key] = [] if k == "tags_json" else {}
    return d


def add_event_sync(data: dict) -> dict:
    # `day` is the user-local date string; `ts` defaults to now but the caller
    # can override (retroactive entries pass the day's noon as a proxy).
    day = data.get("day") or time.strftime("%Y-%m-%d")
    ts = data.get("ts")
    if ts is None:
        # If a retroactive day was given, anchor at local noon so timezone
        # nudges don't push it onto the wrong calendar cell.
        if data.get("day") and data["day"] != time.strftime("%Y-%m-%d"):
            ts = time.mktime(time.strptime(data["day"] + " 12:00", "%Y-%m-%d %H:%M"))
        else:
            ts = time.time()
    tags = data.get("tags") or []
    meta = data.get("meta") or {}
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO event(profile_id, ts, day, category, description, "
            "tags_json, meta_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            (
                data.get("profile_id"),
                ts,
                day,
                data["category"],
                data["description"],
                json.dumps(tags) if tags else None,
                json.dumps(meta) if meta else None,
                time.time(),
            ),
        )
        eid = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM event WHERE id = ?", (eid,)).fetchone()
        return _event_row_to_dict(row)


def list_events_sync(
    since: Optional[str] = None,
    until: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 500,
) -> list[dict]:
    where = ["1=1"]
    params: list[Any] = []
    if since:
        where.append("day >= ?")
        params.append(since)
    if until:
        where.append("day <= ?")
        params.append(until)
    if category:
        where.append("category = ?")
        params.append(category)
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM event WHERE {' AND '.join(where)} "
            f"ORDER BY ts DESC LIMIT ?",
            params,
        ).fetchall()
        return [_event_row_to_dict(r) for r in rows]


def event_category_counts_sync(
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> list[dict]:
    """Group event counts by (day, category) for the trend strip."""
    where = ["1=1"]
    params: list[Any] = []
    if since:
        where.append("day >= ?")
        params.append(since)
    if until:
        where.append("day <= ?")
        params.append(until)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT day, category, COUNT(*) AS n FROM event WHERE "
            f"{' AND '.join(where)} GROUP BY day, category ORDER BY day, category",
            params,
        ).fetchall()
        return [{"day": r["day"], "category": r["category"], "n": r["n"]} for r in rows]


def delete_event_sync(event_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM event WHERE id = ?", (event_id,))
        conn.commit()
        return cur.rowcount > 0


async def add_event(data: dict) -> dict:
    return await asyncio.to_thread(add_event_sync, data)


async def list_events(
    since: Optional[str] = None,
    until: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 500,
) -> list[dict]:
    return await asyncio.to_thread(list_events_sync, since, until, category, limit)


async def event_category_counts(
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> list[dict]:
    return await asyncio.to_thread(event_category_counts_sync, since, until)


async def delete_event(event_id: int) -> bool:
    return await asyncio.to_thread(delete_event_sync, event_id)
