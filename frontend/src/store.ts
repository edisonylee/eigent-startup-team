import { create } from "zustand";

export type Role = "researcher" | "analyst" | "critic" | "summarizer";

export const ROLE_ORDER: Role[] = [
  "researcher",
  "analyst",
  "critic",
  "summarizer",
];

export const ROLE_LABEL: Record<Role, string> = {
  researcher: "Health Researcher",
  analyst: "Health Assessor",
  critic: "Safety Reviewer",
  summarizer: "Plan Writer",
};

export type Status = "pending" | "running" | "done";
export type Phase = "idle" | "running" | "done" | "error";

/** One server-sent event from a run. Mirrors backend/events.py RunEvent. */
export interface RunEvent {
  type:
    | "task_started"
    | "worker_running"
    | "worker_chunk"
    | "worker_usage"
    | "tool_call"
    | "human_input_required"
    | "task_complete"
    | "error";
  role?: Role;
  text?: string;
  mode?: string;
  memo?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  tool_name?: string;
  tool_query?: string;
  retrieved_sources?: { url: string; title: string; score: number }[];
  retrieved_entities?: {
    id: string;
    type: string;
    name: string;
    score: number;
    edge_count: number;
  }[];
  // human_input_required (agent-initiated):
  question?: string;
  choices?: string[];
  request_id?: string;
}

export interface AgentQuestion {
  request_id: string;
  role: Role;
  question: string;
  choices: string[];
}

export interface ToolCall {
  name: string;
  query: string;
  sources?: { url: string; title: string; score: number }[];
  entities?: {
    id: string;
    type: string;
    name: string;
    score: number;
    edge_count: number;
  }[];
}

export interface Biomarker {
  name: string;
  value: string;
  unit?: string | null;
  reference_range?: string | null;
  flag: "normal" | "low" | "high" | "unknown";
}

export interface BiomarkerPanel {
  lab_name?: string | null;
  date?: string | null;
  biomarkers: Biomarker[];
}

interface WorkerState {
  status: Status;
  text: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  toolCalls: ToolCall[];
}

/**
 * A synthesized timeline row built from a live SSE event. Mirrors the DB
 * `run_event` shape so the same renderer can display both. Uses negative
 * ids to avoid colliding with the autoincrementing DB ids.
 */
export interface TimelineRow {
  id: number;
  ts: number;
  kind: string;
  role: string | null;
  payload: Record<string, any>;
}

interface Store {
  phase: Phase;
  idea: string;
  password: string;
  authed: boolean;
  workers: Record<Role, WorkerState>;
  memo: string;
  error: string;
  taskId: string;
  expandedRole: Role | null;
  prompts: Record<Role, string> | null;
  // Agent-initiated questions (mid-run HITL). Queue + current head.
  questionQueue: AgentQuestion[];
  // Live event log for the in-page timeline view. Rebuilt each run.
  eventLog: TimelineRow[];
  // Labs
  labPanel: BiomarkerPanel | null;
  labError: string;
  labLoading: boolean;
  // Setters
  setIdea: (v: string) => void;
  setPassword: (v: string) => void;
  setAuthed: (v: boolean) => void;
  setExpanded: (r: Role | null) => void;
  setPrompts: (p: Record<Role, string>) => void;
  setTaskId: (id: string) => void;
  setLabPanel: (p: BiomarkerPanel | null) => void;
  setLabError: (m: string) => void;
  setLabLoading: (v: boolean) => void;
  dismissQuestion: (request_id: string) => void;
  startRun: () => void;
  startFollowUp: () => void;
  applyEvent: (e: RunEvent) => void;
}

const freshWorker = (): WorkerState => ({
  status: "pending",
  text: "",
  promptTokens: 0,
  completionTokens: 0,
  cost: 0,
  toolCalls: [],
});

const freshWorkers = (): Record<Role, WorkerState> =>
  Object.fromEntries(ROLE_ORDER.map((r) => [r, freshWorker()])) as Record<
    Role,
    WorkerState
  >;

export const useStore = create<Store>((set) => ({
  phase: "idle",
  idea: "",
  password: sessionStorage.getItem("est_pw") || "",
  authed: false,
  workers: freshWorkers(),
  memo: "",
  error: "",
  taskId: "",
  expandedRole: null,
  prompts: null,
  questionQueue: [],
  eventLog: [],
  labPanel: null,
  labError: "",
  labLoading: false,

  setIdea: (v) => set({ idea: v }),
  setPassword: (v) => set({ password: v }),
  setAuthed: (v) => set({ authed: v }),
  setExpanded: (r) => set({ expandedRole: r }),
  setPrompts: (p) => set({ prompts: p }),
  setTaskId: (id) => set({ taskId: id }),
  setLabPanel: (p) => set({ labPanel: p, labError: "" }),
  setLabError: (m) => set({ labError: m }),
  setLabLoading: (v) => set({ labLoading: v }),
  dismissQuestion: (request_id) =>
    set((s) => ({
      questionQueue: s.questionQueue.filter((q) => q.request_id !== request_id),
    })),

  startRun: () =>
    set({
      phase: "running",
      workers: freshWorkers(),
      memo: "",
      error: "",
      questionQueue: [],
      eventLog: [],
    }),

  startFollowUp: () =>
    set((s) => {
      // Reset only Safety Reviewer + Plan Writer; carry over Researcher
      // and Assessor as already-done so the graph visualizes continuity.
      const workers = { ...s.workers };
      workers.critic = freshWorker();
      workers.summarizer = freshWorker();
      // Make sure Researcher and Assessor read as done.
      if (workers.researcher.status !== "done")
        workers.researcher = { ...workers.researcher, status: "done" };
      if (workers.analyst.status !== "done")
        workers.analyst = { ...workers.analyst, status: "done" };
      return {
        phase: "running",
        workers,
        memo: "",
        error: "",
        questionQueue: [],
        eventLog: [],
      };
    }),

  applyEvent: (e) =>
    set((s) => {
      // Append every event (except worker_chunk, too noisy) to the live
      // timeline log. Negative id keeps it from colliding with DB rows.
      const patch: Partial<Store> = {};
      if (e.type !== "worker_chunk") {
        patch.eventLog = [
          ...s.eventLog,
          {
            id: -1 - s.eventLog.length,
            ts: Date.now() / 1000,
            kind: e.type,
            role: e.role ?? null,
            payload: e as unknown as Record<string, any>,
          },
        ];
      }

      const merge = (extra: Partial<Store>): Partial<Store> => ({ ...patch, ...extra });

      if (e.type === "task_started") return merge({ phase: "running" });

      if (e.type === "worker_running" && e.role) {
        const workers = { ...s.workers };
        // Sequential cascade: any other still-running worker is now done.
        for (const r of ROLE_ORDER) {
          if (r !== e.role && workers[r].status === "running") {
            workers[r] = { ...workers[r], status: "done" };
          }
        }
        workers[e.role] = { ...workers[e.role], status: "running" };
        return merge({ workers });
      }

      if (e.type === "worker_chunk" && e.role) {
        const workers = { ...s.workers };
        const prev = workers[e.role];
        const text =
          e.mode === "accumulate"
            ? e.text || ""
            : prev.text + (e.text || "");
        workers[e.role] = { ...prev, status: "running", text };
        return merge({ workers });
      }

      if (e.type === "worker_usage" && e.role) {
        const workers = { ...s.workers };
        workers[e.role] = {
          ...workers[e.role],
          promptTokens: e.prompt_tokens ?? workers[e.role].promptTokens,
          completionTokens:
            e.completion_tokens ?? workers[e.role].completionTokens,
          cost: e.cost ?? workers[e.role].cost,
        };
        return merge({ workers });
      }

      if (e.type === "tool_call" && e.role) {
        const workers = { ...s.workers };
        const prev = workers[e.role];
        workers[e.role] = {
          ...prev,
          toolCalls: [
            ...prev.toolCalls,
            {
              name: e.tool_name || "tool",
              query: e.tool_query || "",
              sources: e.retrieved_sources,
              entities: e.retrieved_entities,
            },
          ],
        };
        return merge({ workers });
      }

      if (e.type === "human_input_required" && e.request_id && e.role) {
        // Agent-initiated mid-run question. Enqueue; modal shows the head.
        // Workers keep their current state — they're paused waiting on
        // the user's answer, not done.
        return merge({
          questionQueue: [
            ...s.questionQueue,
            {
              request_id: e.request_id,
              role: e.role,
              question: e.question || "",
              choices: e.choices || [],
            },
          ],
        });
      }

      if (e.type === "task_complete") {
        const workers = { ...s.workers };
        for (const r of ROLE_ORDER) {
          workers[r] = { ...workers[r], status: "done" };
        }
        return merge({
          phase: "done",
          memo: e.memo || "",
          workers,
          // Keep questionQueue at task end so the modal doesn't blink open
          // for a queued question that the run has already moved past.
          questionQueue: [],
        });
      }

      if (e.type === "error") {
        return merge({
          phase: "error",
          error: e.text || "Run failed.",
          questionQueue: [],
        });
      }

      return patch;
    }),
}));

/** Cumulative cost across all four workers — derived selector. */
export const selectTotalCost = (s: { workers: Record<Role, WorkerState> }) =>
  ROLE_ORDER.reduce((acc, r) => acc + s.workers[r].cost, 0);
