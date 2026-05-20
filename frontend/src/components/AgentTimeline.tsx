import { AnimatePresence, motion } from "framer-motion";
import { useTimeline } from "../lib/queries";
import { ROLE_LABEL, Role, TimelineRow } from "../store";

interface Props {
  /** Read events from the DB via /api/runs/{taskId}/timeline. */
  taskId?: string;
  /** Render these events directly (live-mode override). */
  events?: TimelineRow[];
}

const ROLE_COLOR: Record<string, string> = {
  researcher: "bg-blue-100 text-blue-800",
  analyst: "bg-purple-100 text-purple-800",
  critic: "bg-amber-100 text-amber-800",
  summarizer: "bg-emerald-100 text-emerald-800",
};

export default function AgentTimeline({ taskId, events }: Props) {
  // Live mode: caller passes the event array directly (e.g. from
  // store.eventLog while a run is in progress). Skip the DB fetch.
  const liveMode = events !== undefined;
  const dbQuery = useTimeline(liveMode ? undefined : taskId);

  if (liveMode) {
    if (!events || events.length === 0) {
      return (
        <div className="text-xs text-stone-400">
          Waiting for the first event…
        </div>
      );
    }
    return <Render rows={events} />;
  }

  if (!taskId)
    return (
      <div className="text-xs text-stone-400">No task selected.</div>
    );
  if (dbQuery.isLoading)
    return <div className="text-sm text-stone-500">loading timeline…</div>;
  if (dbQuery.error)
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {String(dbQuery.error)}
      </div>
    );
  const rows = dbQuery.data || [];
  if (rows.length === 0)
    return (
      <div className="text-xs text-stone-400">No events recorded yet.</div>
    );
  return <Render rows={rows} />;
}

function Render({ rows }: { rows: TimelineRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <AnimatePresence initial>
        {rows.map((ev, i) => (
          <motion.div
            key={ev.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.015, 0.6), duration: 0.18 }}
            className="border-b border-stone-100 px-4 py-3 last:border-b-0"
          >
            <Row event={ev} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Row({ event }: { event: { ts: number; kind: string; role: string | null; payload: Record<string, any> } }) {
  const time = new Date(event.ts * 1000).toLocaleTimeString();
  const roleBadge = event.role ? (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${ROLE_COLOR[event.role] || "bg-stone-100 text-stone-700"}`}>
      {ROLE_LABEL[event.role as Role] || event.role}
    </span>
  ) : null;

  const meta = (
    <div className="flex items-center gap-2 text-[11px] text-stone-500">
      <span className="font-mono">{time}</span>
      {roleBadge}
      <span className="font-mono uppercase tracking-wider text-stone-400">
        {event.kind}
      </span>
    </div>
  );

  if (event.kind === "tool_call") {
    return (
      <div>
        {meta}
        <div className="mt-1 text-sm text-stone-800">
          <span className="font-mono">{event.payload.tool_name}</span>
          {event.payload.tool_query && (
            <span className="ml-2 text-stone-500">
              ({event.payload.tool_query})
            </span>
          )}
        </div>
        {(event.payload.retrieved_sources?.length ||
          event.payload.retrieved_entities?.length) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-stone-500 hover:text-stone-800">
              retrieved {(event.payload.retrieved_sources?.length || 0) + (event.payload.retrieved_entities?.length || 0)} item(s)
            </summary>
            <pre className="mt-1 max-h-60 overflow-y-auto rounded bg-stone-50 p-2 text-[10px] font-mono whitespace-pre-wrap">
              {JSON.stringify(
                event.payload.retrieved_sources ||
                  event.payload.retrieved_entities,
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    );
  }

  if (event.kind === "human_input_required") {
    return (
      <div>
        {meta}
        <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-700">
            Agent asked
          </div>
          <div className="mt-0.5 text-sm text-stone-800">
            {event.payload.question}
          </div>
          {event.payload.choices?.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {event.payload.choices.map((c: string, i: number) => (
                <span
                  key={i}
                  className="rounded bg-white px-2 py-0.5 text-[11px] text-stone-700"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (event.kind === "human_input_answered") {
    return (
      <div>
        {meta}
        <div className="mt-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700">
            You answered
          </div>
          <div className="mt-0.5 text-sm text-stone-800">
            {event.payload.answer}
          </div>
        </div>
      </div>
    );
  }

  if (event.kind === "worker_usage") {
    return (
      <div>
        {meta}
        <div className="mt-1 font-mono text-xs text-stone-600">
          prompt {event.payload.prompt_tokens} · completion{" "}
          {event.payload.completion_tokens} · ${" "}
          {(event.payload.cost ?? 0).toFixed(4)}
        </div>
      </div>
    );
  }

  if (event.kind === "worker_chunk") {
    return null; // too noisy for the timeline; show in the worker drawer instead
  }

  if (event.kind === "error") {
    return (
      <div>
        {meta}
        <div className="mt-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {event.payload.text}
        </div>
      </div>
    );
  }

  return (
    <div>
      {meta}
      {event.payload.text && (
        <div className="mt-1 text-sm text-stone-700">{event.payload.text}</div>
      )}
    </div>
  );
}
