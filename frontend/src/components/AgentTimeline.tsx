import { AnimatePresence, motion } from "framer-motion";
import { useTimeline } from "../lib/queries";
import { ROLE_LABEL, Role, TimelineRow } from "../store";
import { Badge } from "./ui/Badge";

interface Props {
  taskId?: string;
  events?: TimelineRow[];
}

const ROLE_TONE: Record<string, React.ComponentProps<typeof Badge>["tone"]> = {
  researcher: "sky",
  analyst: "purple",
  critic: "gold",
  summarizer: "green",
};

export default function AgentTimeline({ taskId, events }: Props) {
  const liveMode = events !== undefined;
  const dbQuery = useTimeline(liveMode ? undefined : taskId);

  if (liveMode) {
    if (!events || events.length === 0) {
      return (
        <div className="text-[12px] text-silver-mist">
          Waiting for the first event…
        </div>
      );
    }
    return <Render rows={events} />;
  }

  if (!taskId)
    return <div className="text-[12px] text-silver-mist">No task selected.</div>;
  if (dbQuery.isLoading)
    return <div className="text-body text-slate-gray">loading timeline…</div>;
  if (dbQuery.error)
    return (
      <div className="rounded-default border border-status-error/30 bg-status-error/10 px-3 py-2 text-[12px] text-status-error">
        {String(dbQuery.error)}
      </div>
    );
  const rows = dbQuery.data || [];
  if (rows.length === 0)
    return (
      <div className="text-[12px] text-silver-mist">No events recorded yet.</div>
    );
  return <Render rows={rows} />;
}

function Render({ rows }: { rows: TimelineRow[] }) {
  return (
    <div className="overflow-hidden rounded-card border border-frost-gray bg-paper-white">
      <AnimatePresence initial>
        {rows.map((ev, i) => (
          <motion.div
            key={ev.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i * 0.015, 0.6), duration: 0.18 }}
            className="border-b border-frost-gray px-4 py-3 last:border-b-0"
          >
            <Row event={ev} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Row({
  event,
}: {
  event: {
    ts: number;
    kind: string;
    role: string | null;
    payload: Record<string, any>;
  };
}) {
  const time = new Date(event.ts * 1000).toLocaleTimeString();
  const meta = (
    <div className="flex items-center gap-2 text-[11px] text-slate-gray">
      <span className="font-mono">{time}</span>
      {event.role && (
        <Badge tone={ROLE_TONE[event.role] ?? "neutral"}>
          {ROLE_LABEL[event.role as Role] || event.role}
        </Badge>
      )}
      <span className="font-mono uppercase tracking-wider text-silver-mist">
        {event.kind}
      </span>
    </div>
  );

  if (event.kind === "tool_call") {
    return (
      <div>
        {meta}
        <div className="mt-1 text-body text-ink-black">
          <span className="font-mono">{event.payload.tool_name}</span>
          {event.payload.tool_query && (
            <span className="ml-2 text-slate-gray">
              ({event.payload.tool_query})
            </span>
          )}
        </div>
        {(event.payload.retrieved_sources?.length ||
          event.payload.retrieved_entities?.length) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-slate-gray hover:text-ink-black">
              retrieved{" "}
              {(event.payload.retrieved_sources?.length || 0) +
                (event.payload.retrieved_entities?.length || 0)}{" "}
              item(s)
            </summary>
            <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-default bg-cloud-canvas p-2 font-mono text-[10px] text-stone-gray">
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
        <div className="mt-1 rounded-default border border-fire-orange/30 bg-fire-orange/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-fire-orange">
            Agent asked
          </div>
          <div className="mt-0.5 text-body text-ink-black">
            {event.payload.question}
          </div>
          {event.payload.choices?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {event.payload.choices.map((c: string, i: number) => (
                <span
                  key={i}
                  className="rounded bg-paper-white/10 px-2 py-0.5 text-[11px] text-stone-gray"
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
        <div className="mt-1 rounded-default border border-status-done/30 bg-status-done/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-status-done">
            You answered
          </div>
          <div className="mt-0.5 text-body text-ink-black">
            {event.payload.answer}
          </div>
        </div>
      </div>
    );
  }

  if (event.kind === "human_input_timeout") {
    return (
      <div>
        {meta}
        <div className="mt-1 rounded-default border border-status-error/30 bg-status-error/5 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-status-error">
            No answer — agent proceeded on default
          </div>
          <div className="mt-0.5 text-body text-ink-black">
            “{event.payload.question}”
          </div>
          <div className="mt-1 text-[12px] text-slate-gray">
            Default used: <span className="font-mono">{event.payload.answer}</span>
          </div>
        </div>
      </div>
    );
  }

  if (event.kind === "worker_usage") {
    return (
      <div>
        {meta}
        <div className="mt-1 font-mono text-[12px] text-slate-gray">
          prompt {event.payload.prompt_tokens} · completion{" "}
          {event.payload.completion_tokens} · ${" "}
          <span className="text-ink-black">
            {(event.payload.cost ?? 0).toFixed(4)}
          </span>
        </div>
      </div>
    );
  }

  if (event.kind === "worker_chunk") {
    return null;
  }

  if (event.kind === "error") {
    return (
      <div>
        {meta}
        <div className="mt-1 rounded-default border border-status-error/30 bg-status-error/10 px-3 py-2 text-body text-status-error">
          {event.payload.text}
        </div>
      </div>
    );
  }

  return (
    <div>
      {meta}
      {event.payload.text && (
        <div className="mt-1 text-body text-stone-gray">
          {event.payload.text}
        </div>
      )}
    </div>
  );
}
