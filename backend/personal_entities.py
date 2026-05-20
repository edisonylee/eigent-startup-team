"""Personal entity extraction + memory-graph data.

Distinct from the canonical health graph in `data/health_graph.yaml`:
canonical nodes (vitamin_d, magnesium, t2_diabetes_risk, ...) are the
same for every user. *Personal* entities are user-specific — doctors,
gyms, family members, trips, the specific supplements the user is
actually on — extracted from the user's own data: plan memos, check-in
notes, the profile note, and lab biomarker names.

Each personal entity optionally links to a canonical node via
`canonical_id` when the extraction matches a canonical name or alias.
That lets the memory-graph viz overlay user history onto the canonical
knowledge graph.

Two-phase extraction:
  1. Rule-based pass: match against canonical graph names + aliases.
     High precision; cheap; no LLM call.
  2. LLM pass: open-set types (provider, person, place, activity)
     that the canonical graph doesn't know about, via a typed Pydantic
     response_format.
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

from pydantic import BaseModel, Field

from camel.agents import ChatAgent

from src.graph_rag import _load as _load_graph
from src.model_config import build_model

from .db import _connect


# ---------- Schemas ----------

class ExtractedEntity(BaseModel):
    name: str = Field(
        description="Canonical surface form, e.g. 'Vitamin D', 'Dr. Smith'."
    )
    type: str = Field(
        description=(
            "One of: nutrient | condition | provider | medication | food | "
            "place | person | activity | other."
        )
    )


class EntityExtraction(BaseModel):
    entities: list[ExtractedEntity]


# ---------- Canonical index (cached once) ----------

_canonical_cache: Optional[dict[str, tuple[str, str, str]]] = None


def _canonical_index() -> dict[str, tuple[str, str, str]]:
    """Map lowercase name/alias → (canonical_id, canonical_type, display_name)."""
    global _canonical_cache
    if _canonical_cache is not None:
        return _canonical_cache
    try:
        g, _, _ = _load_graph()
    except Exception:
        return {}
    idx: dict[str, tuple[str, str, str]] = {}
    for nid in g.nodes:
        attrs = g.nodes[nid]
        display = attrs.get("name") or nid
        ctype = attrs.get("type", "entity")
        terms = [display] + (attrs.get("aliases") or [])
        for term in terms:
            if not term:
                continue
            key = term.lower()
            # First write wins (so the primary name dominates over aliases)
            idx.setdefault(key, (nid, ctype, display))
    _canonical_cache = idx
    return idx


# ---------- LLM extraction ----------

_EXTRACTOR_PROMPT = """You extract real-world entities from text in a
personal health journal. Categories:

  - nutrient    — vitamins, minerals, supplements (Vitamin D, magnesium, fish oil)
  - condition   — health conditions or symptoms named (back pain, T2 diabetes)
  - provider    — doctors, clinics, dietitians, therapists (Dr. Smith, the cardiologist)
  - medication  — prescription drugs by name
  - food        — specific foods or food groups emphasized
  - place       — gyms, workplaces, trips, locations
  - person      — non-provider people mentioned (partner, parent, friend)
  - activity    — exercise types, hobbies (running, yoga, cycling)
  - other       — important entities outside the above

Rules:
  - Extract only entities ACTUALLY MENTIONED. Don't infer.
  - Use canonical surface forms ("Vitamin D", not "vit d").
  - Skip generic ambient words ("water", "food", "sleep") unless used as a named entity.
  - For non-named people use a descriptor ("my partner").
  - Return strictly the typed EntityExtraction schema.
"""


def _extractor_agent() -> ChatAgent:
    return ChatAgent(
        system_message=_EXTRACTOR_PROMPT,
        model=build_model(stream=False, temperature=0.0),
    )


def _llm_extract(text: str) -> list[ExtractedEntity]:
    if not text or not text.strip():
        return []
    if len(text) > 8000:
        text = text[:8000]
    agent = _extractor_agent()
    try:
        resp = agent.step(
            f"Extract entities from this text:\n\n---\n{text}\n---",
            response_format=EntityExtraction,
        )
    except Exception:
        return []
    msg = resp.msgs[0]
    parsed = getattr(msg, "parsed", None)
    if isinstance(parsed, EntityExtraction):
        return parsed.entities
    try:
        return EntityExtraction.model_validate_json(msg.content).entities
    except Exception:
        return []


# ---------- Combined extraction ----------

def extract_entities(text: str) -> list[dict]:
    """Return list of {name, type, canonical_id} for entities in `text`.

    Phase 1: canonical-graph alias matching (rule-based).
    Phase 2: LLM extraction for open-set categories.

    Phase 1 results dominate on duplicates so canonical links are preserved.
    """
    if not text or not text.strip():
        return []

    found: dict[tuple[str, str], dict] = {}  # (name_lower, type) → record

    # Phase 1: canonical
    text_lower = text.lower()
    for term, (canonical_id, canonical_type, display) in _canonical_index().items():
        # Only match whole-word-ish presence to avoid "iron" matching "iron-ic".
        if _term_in_text(term, text_lower):
            key = (display.lower(), canonical_type)
            if key not in found:
                found[key] = {
                    "name": display,
                    "type": canonical_type,
                    "canonical_id": canonical_id,
                }

    # Phase 2: LLM
    for ent in _llm_extract(text):
        key = (ent.name.lower(), ent.type)
        if key in found:
            continue
        # Late canonical link attempt
        cid = _canonical_index().get(ent.name.lower())
        canonical_id = cid[0] if cid else None
        found[key] = {
            "name": ent.name,
            "type": ent.type,
            "canonical_id": canonical_id,
        }

    return list(found.values())


def _term_in_text(term: str, text_lower: str) -> bool:
    """Lightweight whole-token presence check. Avoids short-substring noise."""
    if len(term) < 4:
        # For short terms, require word boundaries (cheap heuristic)
        import re
        return re.search(rf"\b{re.escape(term)}\b", text_lower) is not None
    return term in text_lower


# ---------- Persistence ----------

def _upsert_entity_sync(name: str, type_: str, canonical_id: Optional[str]) -> int:
    now = time.time()
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, canonical_id FROM personal_entity WHERE name = ? AND type = ?",
            (name, type_),
        ).fetchone()
        if row:
            eid = row["id"]
            conn.execute(
                "UPDATE personal_entity SET last_seen = ?, mention_count = mention_count + 1, "
                "canonical_id = COALESCE(canonical_id, ?) WHERE id = ?",
                (now, canonical_id, eid),
            )
        else:
            cur = conn.execute(
                "INSERT INTO personal_entity"
                "(name, type, canonical_id, first_seen, last_seen, mention_count) "
                "VALUES(?, ?, ?, ?, ?, 1)",
                (name, type_, canonical_id, now, now),
            )
            eid = cur.lastrowid
        conn.commit()
        return eid


def _add_mention_sync(
    entity_id: int, source_kind: str, source_id: str, snippet: Optional[str]
) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO entity_mention"
            "(entity_id, source_kind, source_id, context_snippet, ts) "
            "VALUES(?, ?, ?, ?, ?)",
            (entity_id, source_kind, source_id, snippet[:240] if snippet else None, time.time()),
        )
        conn.commit()


def _snippet_around(text: str, term: str, width: int = 200) -> str:
    """Return a ~`width` char window centered on `term`'s first occurrence."""
    idx = text.lower().find(term.lower())
    if idx < 0:
        return text[:width].strip()
    half = width // 2
    start = max(0, idx - half)
    end = min(len(text), idx + len(term) + half)
    return text[start:end].strip()


def index_text_sync(text: str, source_kind: str, source_id: str) -> int:
    """Extract from `text` + persist mentions. Returns number of entities indexed."""
    entities = extract_entities(text)
    for ent in entities:
        eid = _upsert_entity_sync(ent["name"], ent["type"], ent.get("canonical_id"))
        _add_mention_sync(eid, source_kind, source_id, _snippet_around(text, ent["name"]))
    return len(entities)


async def index_text(text: str, source_kind: str, source_id: str) -> int:
    return await asyncio.to_thread(index_text_sync, text, source_kind, source_id)


def index_biomarker_ids_sync(row_ids: list[int]) -> int:
    """Index a specific set of newly-inserted biomarker rows.

    Mirrors the biomarker block in `index_existing_data_sync` but scoped
    to a single panel so a lab upload doesn't re-walk all sources.
    """
    if not row_ids:
        return 0
    placeholders = ",".join("?" for _ in row_ids)
    indexed = 0
    with _connect() as conn:
        for r in conn.execute(
            f"SELECT id, name, value, unit, flag FROM biomarker WHERE id IN ({placeholders})",
            row_ids,
        ).fetchall():
            display = r["name"]
            cid = _canonical_index().get(display.lower())
            canonical_id = cid[0] if cid else None
            ctype = cid[1] if cid else "biomarker"
            eid = _upsert_entity_sync(display, ctype, canonical_id)
            unit = r["unit"] or ""
            flag = r["flag"] or "unknown"
            snippet = f"{display}: {r['value']} {unit} [{flag}]"
            _add_mention_sync(eid, "lab_biomarker", str(r["id"]), snippet)
            indexed += 1
    return indexed


# ---------- One-shot indexer over existing SQLite data ----------

def index_existing_data_sync() -> dict:
    """Walk run.memo, check_in.adherence_notes, profile.notes, biomarker,
    and event.description and persist mentions. Idempotent re entity rows;
    mention rows accumulate. Use the `clear` flag (via the API) if you
    need a clean slate."""
    counts = {
        "run_memos": 0,
        "check_ins": 0,
        "profile": 0,
        "biomarkers": 0,
        "events": 0,
    }

    with _connect() as conn:
        # Plan memos
        rows = conn.execute(
            "SELECT task_id, memo FROM run WHERE memo IS NOT NULL AND memo != ''"
        ).fetchall()
        for r in rows:
            n = index_text_sync(r["memo"], "run_memo", r["task_id"])
            counts["run_memos"] += n

        # Check-in adherence notes
        rows = conn.execute(
            "SELECT id, adherence_notes FROM check_in "
            "WHERE adherence_notes IS NOT NULL AND adherence_notes != ''"
        ).fetchall()
        for r in rows:
            n = index_text_sync(r["adherence_notes"], "check_in_note", str(r["id"]))
            counts["check_ins"] += n

        # Profile notes
        prow = conn.execute(
            "SELECT id, notes FROM profile WHERE notes IS NOT NULL AND notes != '' LIMIT 1"
        ).fetchone()
        if prow:
            n = index_text_sync(prow["notes"], "profile_note", str(prow["id"]))
            counts["profile"] += n

        # Lab biomarker names — direct upserts (not text extraction)
        for r in conn.execute(
            "SELECT id, name, value, unit, flag FROM biomarker"
        ).fetchall():
            display = r["name"]
            cid = _canonical_index().get(display.lower())
            canonical_id = cid[0] if cid else None
            ctype = cid[1] if cid else "biomarker"
            eid = _upsert_entity_sync(display, ctype, canonical_id)
            unit = r["unit"] or ""
            flag = r["flag"] or "unknown"
            snippet = f"{display}: {r['value']} {unit} [{flag}]"
            _add_mention_sync(eid, "lab_biomarker", str(r["id"]), snippet)
            counts["biomarkers"] += 1

        # Events — any free-form description (notes, symptoms, meals, etc.)
        # The `note` category is the most prose-heavy, but everything with
        # a description carries entity signal worth extracting.
        for r in conn.execute(
            "SELECT id, category, description FROM event "
            "WHERE description IS NOT NULL AND description != ''"
        ).fetchall():
            text = f"[{r['category']}] {r['description']}"
            n = index_text_sync(text, "event_note", str(r["id"]))
            counts["events"] += n

    return counts


async def index_existing_data() -> dict:
    return await asyncio.to_thread(index_existing_data_sync)


def clear_entities_sync() -> None:
    """Wipe both tables. Useful when re-extracting from scratch."""
    with _connect() as conn:
        conn.execute("DELETE FROM entity_mention")
        conn.execute("DELETE FROM personal_entity")
        conn.commit()


# ---------- Graph data for the viz ----------

def get_graph_data_sync(min_mentions: int = 1) -> dict:
    """Return `{nodes, links}` for the force-directed memory graph.

    Nodes: entities with `mention_count >= min_mentions`.
    Links: co-mention edges, i.e. pairs of entities that appeared in the
    same `(source_kind, source_id)`. Edge weight = co-occurrence count.
    """
    with _connect() as conn:
        node_rows = conn.execute(
            "SELECT id, name, type, canonical_id, mention_count, first_seen, last_seen "
            "FROM personal_entity WHERE mention_count >= ? "
            "ORDER BY mention_count DESC",
            (min_mentions,),
        ).fetchall()
        nodes = [
            {
                "id": r["id"],
                "name": r["name"],
                "type": r["type"],
                "canonical_id": r["canonical_id"],
                "mention_count": r["mention_count"],
                "first_seen": r["first_seen"],
                "last_seen": r["last_seen"],
            }
            for r in node_rows
        ]
        node_ids = {n["id"] for n in nodes}

        link_rows = conn.execute(
            """
            SELECT m1.entity_id AS a, m2.entity_id AS b, COUNT(*) AS w
            FROM entity_mention m1
            JOIN entity_mention m2
              ON m1.source_kind = m2.source_kind
             AND m1.source_id   = m2.source_id
             AND m1.entity_id   < m2.entity_id
            GROUP BY m1.entity_id, m2.entity_id
            HAVING COUNT(*) >= 1
            ORDER BY w DESC
            LIMIT 500
            """
        ).fetchall()
        links = [
            {"source": r["a"], "target": r["b"], "value": r["w"]}
            for r in link_rows
            if r["a"] in node_ids and r["b"] in node_ids
        ]

    return {"nodes": nodes, "links": links}


async def get_graph_data(min_mentions: int = 1) -> dict:
    return await asyncio.to_thread(get_graph_data_sync, min_mentions)


def get_entity_mentions_sync(entity_id: int, limit: int = 50) -> dict:
    with _connect() as conn:
        ent = conn.execute(
            "SELECT id, name, type, canonical_id, mention_count, first_seen, last_seen "
            "FROM personal_entity WHERE id = ?",
            (entity_id,),
        ).fetchone()
        if not ent:
            return {"entity": None, "mentions": []}
        rows = conn.execute(
            "SELECT id, source_kind, source_id, context_snippet, ts "
            "FROM entity_mention WHERE entity_id = ? "
            "ORDER BY ts DESC LIMIT ?",
            (entity_id, limit),
        ).fetchall()
        return {
            "entity": dict(ent),
            "mentions": [dict(r) for r in rows],
        }


async def get_entity_mentions(entity_id: int, limit: int = 50) -> dict:
    return await asyncio.to_thread(get_entity_mentions_sync, entity_id, limit)
