# HealthOS — Eigent Health Team v3

A local-capable, MCP-native health command center built on
[CAMEL](https://github.com/camel-ai/camel). Four specialist agents
coordinated by a `Workforce` for comprehensive plans, plus a single-agent
`Ask` lane for quick questions, plus an auto-rolling "About me"
synthesis that the agents read at the start of every run so the user
never has to redescribe themselves. Persistent SQLite history, swappable
model backends (OpenAI default, Ollama opt-in), an Electron desktop
shell.

> **Educational information only.** This project is not medical advice and not a
> substitute for a qualified healthcare professional. It does not diagnose. Always
> consult a clinician before changing your health routine, and seek prompt care for
> any concerning symptoms.

## The mental model

```
┌────────────────────────────────────────────────────────────────────┐
│ Today                          │  raw inputs the user writes        │
│ ├ daily check-in (energy/sleep/mood + adherence notes)              │
│ ├ retroactive calendar event   │  symptom · meal · sleep · exercise │
│ └ (lab PDF, on the Plan page)  │  supplement · medication · mood · note│
└──────────────────────────────────┬─────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│ Memory   ──  what the system has compressed from those inputs        │
│ ├ About me   prose synthesis (auto-rolled by a CAMEL ChatAgent      │
│ │            after each check-in + each completed run)              │
│ ├ Graph      force-directed entity graph extracted from all sources │
│ ├ Sources    every check-in/run memo/biomarker/note that fed it     │
│ └ History    chronological event log                                │
└──────────────────────────────────┬─────────────────────────────────┘
                                   ▼
┌──────────────────────────┐  ┌──────────────────────────────────────┐
│ Ask  (single agent)      │  │ Plan  (full Workforce)               │
│ - ASK_PROMPT             │  │ - Researcher → Assessor →            │
│ - profile auto-loaded    │  │   Safety Reviewer → Plan Writer      │
│ - no tools, no retrieval │  │ - real MCP tools, mid-run HITL,      │
│ - ~$0.005, ~10s          │  │   curated KB + DuckDuckGo fallback   │
│ - prose answer           │  │ - ~$0.01–0.05, ~1–3 min              │
│                          │  │ - structured markdown plan           │
└──────────────────────────┘  └──────────────────────────────────────┘
```

Everything the user produces upstream flows into memory; everything in
memory is automatically loaded into both Ask and Plan. The user never
re-explains themselves — the question is just "what do you want to know
this time?"

## The four routes

| Route | Purpose | Writes to |
|---|---|---|
| **`/today`** | Daily check-in (energy/sleep/mood/notes) + a calendar showing every check-in (orange ring) and every event (category dot). Click any day → modal with the day's check-in + events + an "Add note or event" form. | `check_in`, `event` |
| **`/memory`** | Tabbed view: **About me** (the synthesis), **Graph** (force-directed entity graph, sources inlined), **History** (chronological event log). | reads only |
| **`/ask`** | Chat-style Q&A. One `ChatAgent` with `ASK_PROMPT`, profile synthesis auto-loaded, **no tools** — the synthesis is the entire grounding. Streams a 1–3 paragraph answer. | `run` (`mode='ask'`) |
| **`/plan`** | Past plans + "Start a new plan →" which opens `/plan/new` — the full Workforce composer with live agent timeline, lab upload, mid-run HITL, follow-up input. | `run` (`mode='plan'`) |
| `/settings` | Model backend (OpenAI/Ollama), MCP server status, profile, data export/wipe. | settings + profile |
| `/runs/:taskId/timeline` | Full chronological view of any past run. | reads only |
| ⌘K palette | Navigate routes + hot-swap model backend. | — |

## Run it

```bash
# 1. one-time deps
curl -LsSf https://astral.sh/uv/install.sh | sh    # uv
uv sync                                             # python deps
cp .env.example .env                                # add OPENAI_API_KEY (+ optional FIRECRAWL_API_KEY for KB seeding, BRAVE_API_KEY for the Brave MCP)
cd frontend && npm install && cd ..

# 2. populate the curated KB (one-time, ~5–15 min, needs FIRECRAWL_API_KEY)
uv run python -m scripts.ingest_kb

# 3. backend (terminal 1)
uv run uvicorn backend.server:app --port 8000

# 4. frontend (terminal 2)
cd frontend && npm run dev
# open the Vite URL, hit Today to log a check-in (seeds the memory),
# then Ask for a quick question or Plan for a full Workforce run
```

`APP_PASSWORD` is optional — leave it unset for desktop / local use; set
it in `.env` only when hosting on a shared deployment to re-enable the
password gate. No Docker — Chroma runs in-process, MCP servers spawn as
stdio subprocesses, SQLite lives at `~/.healthos/healthos.db`.

### Switch to fully-local

```bash
ollama serve              # in its own terminal
ollama pull llama3.1:8b   # ~5 GB
```

Then open **Settings → Model** in the UI, pick **Ollama**, hit *Use local Ollama*.
Runs cost $0; nothing leaves the machine for the model call. (Brave web
search still uses cloud unless you also drop the Brave MCP server.)

## v3 architecture

### Two query modes: Ask vs Plan

| | `Ask` | `Plan` |
|---|---|---|
| Agents | 1 `ChatAgent` (`ASK_PROMPT`) | 4-agent Workforce (Researcher → Assessor → Safety Reviewer → Plan Writer) |
| Tools | none — the synthesis is the grounding | Curated KB, canonical health graph, personal memory graph, notes filesystem, Brave (opt-in), DuckDuckGo fallback, `request_human_input` |
| Web search | no | DuckDuckGo always; Brave when configured |
| Profile auto-loaded? | yes (synthesis prepended to user input) | yes (synthesis prepended to task content) |
| Latency | ~5–15s | ~1–3 min |
| Cost | ~$0.005 | ~$0.01–0.05 |
| Output | 1–3 paragraphs of prose | Structured markdown plan with safety verdict |
| Persisted as | `run` row with `mode='ask'` | `run` row with `mode='plan'` (default) |

Both routes write back into the memory loop: each answer/plan gets
indexed into the entity graph and triggers a profile-synthesis refresh.

### Profile synthesis (the auto About-me)

`backend/profile_synthesis.py` is a daemon-thread-spawned CAMEL
`ChatAgent` that rolls the user's longitudinal data into a 4–6 paragraph
"About me" written in 2nd person ("you have…", "you train at…").
Inputs:

- **Profile basics** (name, dob, sex from `profile`)
- **Last 21 check-ins** (`check_in.adherence_notes` + stats)
- **Last 5 run memos** (`run.memo` + `run.idea`)
- **All current biomarkers** (latest value per name, with flags)
- **Last 40 events** (`event.description` — notes, symptoms, meals, etc.)
- **Top 80 memory-graph entities** (the longitudinal cross-reference —
  the people, places, supplements, conditions, foods that recur the most)

The output is stored back into `profile.notes` and a synthesis timestamp
is stamped into the `setting` table. The UI shows "Synthesized 4m ago ·
from 21 check-ins, 5 run memos, 8 biomarkers." Triggers (all fire-and-
forget on a daemon thread, same pattern as `_spawn_entity_extract`):

- After `POST /api/check_ins` succeeds
- After `POST /api/events` succeeds
- After a full `_run` completes
- After a follow-up `_run_followup` completes
- After an `_run_ask` completes
- Manually via the "Synthesize now" button on `/memory`

That single paragraph then gets prepended to the user input of every
subsequent Ask and Plan — the agents never see a freshly-typed bio.

### Memory graph (entities + observations)

`backend/personal_entities.py` builds nodes from seven source kinds and
stores them in `personal_entity` + `entity_mention`:

| Source kind | Where it comes from |
|---|---|
| `check_in_note` | `check_in.adherence_notes` |
| `run_memo` | `run.memo` (both `plan` and `ask` rows) |
| `profile_note` | `profile.notes` (i.e. the synthesis itself) |
| `lab_biomarker` | `biomarker.name` |
| `event_note` | `event.description` (any category — note, meal, symptom, …) |
| `check_in_observation` | check-in scalars bucketed into `low/mid/high {sleep,energy,mood}` nodes |
| `event_observation` | scalar event meta (sleep hours, mood, symptom severity), bucketed the same way |

So the graph fuses two node shapes: **named entities** (nutrients,
providers, foods, …) and **observation buckets** (stable `low/mid/high`
nodes for how the user actually feels).

Extraction is two-phase: rule-based matching against
`data/health_graph.yaml` aliases (high-precision, no LLM) plus a typed
Pydantic `EntityExtraction` LLM call for open-set types
(`provider`, `place`, `person`, `activity`, `other`). Edges are computed
two ways and summed: **same-source co-mention** (two entities in the same
`(source_kind, source_id)`) and **same-day co-occurrence** (entities
mentioned on the same calendar day across different sources) — the latter
is what links a "magnesium" note to the "high sleep" bucket from the same
day's check-in.

The viz on `/memory` → Graph uses `react-force-graph-2d`. Per-type
colors map to a 10-bucket palette (observations pink); canonical-matched
entities get a white ring so the user sees the overlap between their
personal graph and the curated ontology.

### Calendar + events

`/today` shows a 6×7 monthly grid (`frontend/src/components/CalendarStrip.tsx`).
Day cells render category dots for any `event` row + an orange ring if
a check-in was logged that day. Click a cell → modal showing that day's
check-in (read-only) plus its events + an "Add note or event" form
defaulting to category `note`. Categories:
`symptom | meal | sleep | exercise | supplement | medication | mood | note`.

### Model backends (OpenAI default, Ollama opt-in)

`src/model_config.py` exposes `ModelBackend` (`openai` | `ollama`) and a
`build_model()` factory. Every agent in the codebase routes through it —
swapping backends from the Settings UI hot-reloads the next agent created,
with no restart. Pricing is per-backend (Ollama returns `cost=0`). Prompt
caching is surfaced (50% discount on cached input tokens for OpenAI).

### Real MCP integration

`backend/mcp_manager.py` spawns up to three stdio MCP servers in the FastAPI
lifespan:

| Server | Type | Default state |
|---|---|---|
| `health_kb` | Custom (this repo) — wraps `src/rag.py` + `src/graph_rag.py` | always on |
| `filesystem` | Official `@modelcontextprotocol/server-filesystem` rooted at `~/.healthos/notes/` | on if `npx` present |
| `brave_search` | Official `@modelcontextprotocol/server-brave-search` | on if `BRAVE_API_KEY` set |

**Hot-path caveat.** The Python MCP SDK's `ClientSession.call_tool` is
task-affinity-sensitive — calls dispatched from a different asyncio task
than the one that opened the session can deadlock. So the runner calls
`src.rag.search_health_kb` and `src.graph_rag.search_health_graph`
directly in-process for the Researcher's KB and graph tools (same
Chroma store, same data, no transport overhead). The MCP servers stay
alive and visible in `/settings`; the filesystem-notes and Brave tools
genuinely do route through MCP because they're external integrations
where MCP is the point.

### Researcher reliability

Three layered fallbacks keep the Workforce from halting on an empty or
flaky retrieval result:

1. **Curated KB ingestion** — `scripts/ingest_kb.py` crawls the URLs in
   `data/kb_sources.txt` via Firecrawl, chunks at ~500 tokens, embeds
   with sentence-transformers, upserts into Chroma. Roughly 28 sources →
   ~185 chunks of NIH ODS / CDC / AHA / USDA / Mayo content.
2. **DuckDuckGo fallback** — wired into the Researcher's tool list when
   Brave isn't configured. Guarded import; rate-limit failures silently
   skip without breaking the run.
3. **Graceful-degradation prompt** — `RESEARCHER_PROMPT` no longer tells
   the agent to refuse when curated tools return nothing. Instead it
   falls back to general clinical knowledge with an explicit
   *"(general clinical knowledge, not from a curated source)"* caveat.
   *Never refuse the task outright; partial citations are better than no
   plan.*

### Human-in-the-loop (mid-run, agent-initiated)

Each Workforce agent has a `request_human_input(question, choices)` tool.
When the agent decides it needs clarification, the runner emits a
`human_input_required` SSE event, the UI surfaces a question modal, and
the tool's thread blocks on a `threading.Event` until
`POST /api/run/{task_id}/answer` resolves it. "Use your best judgment" is
always available — completed work is never thrown away.

The timeline view renders question/answer pairs as a first-class row type
(see `frontend/src/components/AgentTimeline.tsx`).

### Persistence — SQLite, no daemon

`backend/db.py` keeps everything at `~/.healthos/healthos.db`:

| Table | What it holds |
|---|---|
| `profile` | Single row: name, dob, sex, height, weight, `notes` (= the auto-synthesis text) |
| `biomarker` | Append-only history of parsed lab values |
| `run` | One row per run: `task_id`, `idea`, `memo`, `cost_usd`, `mode` (`plan` \| `ask`) |
| `run_event` | Full SSE event log per run; powers the timeline view |
| `check_in` | Daily check-ins (energy/sleep/mood/adherence notes) |
| `event` | Point events (`category`, `description`, `tags`, `meta`) — calendar substrate |
| `personal_entity` | Entities extracted from all sources; powers the memory graph |
| `entity_mention` | Per-source occurrences of each entity; powers the Sources panel |
| `setting` | Key/value (active model backend, synthesis timestamp, etc.) |

Schema is idempotent — `scripts/init_db.py` or the FastAPI lifespan
creates it on first boot. Additive migrations (e.g. `run.mode`) are
gated on `PRAGMA table_info` checks so existing DBs upgrade silently.

### Embedded Chroma vector store

`src/rag.py` uses [`chromadb`](https://www.trychroma.com/) in embedded mode.
Storage at `~/.healthos/vector/`. Maintainers can ship a prebuilt snapshot:

```bash
uv run python -m scripts.ingest_kb        # populate from kb_sources.txt
uv run python -m scripts.build_kb_bundle  # snapshot into data/health_kb_chroma/
```

On first launch with an empty user data dir, `_maybe_seed_from_bundle` copies
the shipped snapshot into place — first-run installs work without Firecrawl.

### Hand-curated knowledge graph

`data/health_graph.yaml` → NetworkX `MultiDiGraph` at startup. 65
entities, 124 typed edges (`addresses`, `found_in`, `measured_by`,
`interacts_with`, `risk_factor_for`, `contraindicated_with`).
Sub-millisecond traversal; queries embedded with the same local
sentence-transformers model that powers the KB.

## Desktop shell

```bash
cd electron
npm install
npm start   # tsc → electron dist/main.js
```

Spawns `uv run uvicorn backend.server:app` as a child, polls
`/api/health`, then loads the app in a BrowserWindow. Cmd/Ctrl+Shift+H
toggles the window. Tray menu has Show / New check-in / Quit. Killing
the Electron process kills the backend child.

Distributable `.dmg` / `.exe` builds and full PyInstaller bundling are
a follow-up — for now the shell expects `uv` on `PATH`.

## Project layout

```
eigent-health-team/
├── pyproject.toml         # uv-managed deps
├── src/                   # CAMEL agents + model factory + RAG + lab parser
│   ├── model_config.py    # OpenAI / Ollama backend abstraction
│   ├── agents.py          # ChatAgent builders + system prompts (incl. ASK_PROMPT)
│   ├── workforce.py       # wires agents into a CAMEL Workforce
│   ├── rag.py             # embedded Chroma retrieval
│   ├── graph_rag.py       # NetworkX health knowledge graph
│   └── lab_parser.py      # typed BiomarkerPanel extraction
├── backend/               # FastAPI app
│   ├── db.py              # SQLite persistence
│   ├── events.py          # typed RunEvent model
│   ├── runner.py          # Workforce + Ask runners, SSE stream, HITL, tool wrappers
│   ├── personal_entities.py # 5-source-kind entity extraction + memory graph
│   ├── profile_synthesis.py # auto "About me" generator
│   ├── mcp_manager.py     # stdio MCP server lifecycle
│   ├── routers/
│   │   ├── memory_graph.py  # /api/memory-graph, /sources, /reindex
│   │   └── events.py        # /api/events for the calendar substrate
│   └── server.py          # routes (incl. /api/ask, /api/run, /api/profile/synthesis)
├── mcp_servers/           # custom health_kb stdio MCP server
├── frontend/              # React + react-router + react-query + framer-motion + cmdk
│   └── src/
│       ├── Layout.tsx              # nav (Today · Memory · Ask · Plan · Settings)
│       ├── App.tsx                 # /plan/new — the full Workforce composer
│       ├── components/CalendarStrip.tsx  # month grid + day modal
│       ├── components/AgentTimeline.tsx  # Q&A pair rendering, live + DB modes
│       ├── components/MemoPanel.tsx
│       ├── components/CommandPalette.tsx
│       └── routes/                 # Today · Memory · Ask · Plan · Profile · Settings · Agents · Evals · MemoryGraph · CheckIn · Timeline
├── electron/              # Desktop wrapper (main + preload + tray)
├── data/                  # health_graph.yaml + kb_sources.txt + optional health_kb_chroma snapshot
├── scripts/               # ingest_kb · build_kb_bundle · init_db · seed_memory_demo
└── evals/                 # deterministic + LLM-judge + cost_table
```

## Evals

```bash
uv run python -m evals.deterministic   # typed-output assertion on a risky profile
uv run python -m evals.llm_judge       # 1-5 ratings on coherence / actionability / safety / personalization
uv run python -m evals.cost_table      # per-worker token / cost / latency
```

The `/evals` route in the UI reads `evals/results.csv` and surfaces means.

## Seed demo data

`scripts/seed_memory_demo.py` drops a realistic batch of check-ins,
run memos, a profile note, and biomarkers, then re-extracts the entity
graph. Idempotent (skips days already seeded). Useful for screenshots
and demo videos when you don't want to type 30 days of check-ins by
hand.

```bash
uv run python -m scripts.seed_memory_demo
```

## Known limitations

1. **Sequential latency in Plan.** Research → assessment → safety review → plan is a chain. Ask sidesteps this entirely.
2. **Safety Reviewer anchoring.** It reasons over upstream framing; intentional cost of the Workforce shape.
3. **MCP Python SDK + asyncio task affinity.** `ClientSession.call_tool` from a non-owner task can deadlock — that's why in-process tools (KB, graph) call their underlying Python functions directly. Filesystem and Brave (real external integrations) stay on MCP.
4. **PyInstaller backend bundling deferred.** Electron expects `uv` on PATH.
5. **Multi-profile not modeled yet.** Schema has a single profile row; the synthesis is per-DB, not per-user.

## Built on

[CAMEL-AI](https://www.camel-ai.org/) — the multi-agent framework behind
the `Workforce` orchestration, `ChatAgent`, and MCP tooling used throughout.
