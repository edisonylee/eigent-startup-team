import { useMCPServers, useModelStatus, usePrompts } from "../lib/queries";
import { ROLE_LABEL, ROLE_ORDER, Role } from "../store";

const ROLE_TOOLS: Record<Role, string[]> = {
  researcher: [
    "query_health_graph",
    "search_health_kb",
    "list_notes",
    "read_notes",
    "search_brave",
  ],
  analyst: [],
  critic: [],
  summarizer: [],
};

// Each agent-facing tool name routes through a specific MCP server.
// Used to compute connected/disabled state without exposing raw MCP
// tool names in the roster UI.
const TOOL_TO_SERVER: Record<string, string> = {
  query_health_graph: "health_kb",
  search_health_kb: "health_kb",
  list_notes: "filesystem",
  read_notes: "filesystem",
  search_brave: "brave_search",
};

const ROLE_BLURB: Record<Role, string> = {
  researcher:
    "Gathers evidence from a curated graph, a vector KB, and (optionally) the open web.",
  analyst: "Picks the 3–4 highest-leverage focus areas from the profile.",
  critic: "Pressure-tests the plan for risks, contraindications, and red flags.",
  summarizer: "Assembles the final personalized health plan in markdown.",
};

export default function Agents() {
  const { data: prompts } = usePrompts();
  const { data: status } = useModelStatus();
  const { data: servers } = useMCPServers();

  const connectedServers = new Set(
    (servers || []).filter((s) => s.status === "connected").map((s) => s.name),
  );
  const isToolLive = (tool: string) => {
    const server = TOOL_TO_SERVER[tool];
    return server ? connectedServers.has(server) : false;
  };

  return (
    <div className="px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 font-serif text-2xl text-stone-900">Agent roster</h1>
        <p className="mb-5 text-sm text-stone-500">
          Four specialists, coordinated by a CAMEL Workforce. Each can ask the
          user a clarifying question mid-run via the in-process{" "}
          <code className="rounded bg-stone-100 px-1">request_human_input</code>{" "}
          tool.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ROLE_ORDER.map((role) => (
            <div
              key={role}
              className="rounded-lg border border-stone-200 bg-white p-5"
            >
              <div className="mb-1 text-[11px] uppercase tracking-wider text-stone-400">
                {role}
              </div>
              <h2 className="font-serif text-lg text-stone-900">
                {ROLE_LABEL[role]}
              </h2>
              <p className="mt-1 text-sm text-stone-600">{ROLE_BLURB[role]}</p>

              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wider text-stone-400">
                  Tools
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ROLE_TOOLS[role].map((t) => {
                    const live = isToolLive(t);
                    return (
                      <span
                        key={t}
                        className={
                          "rounded px-2 py-0.5 font-mono text-[10px] " +
                          (live
                            ? "bg-green-100 text-green-800"
                            : "bg-stone-100 text-stone-500")
                        }
                        title={
                          live
                            ? `via MCP (${TOOL_TO_SERVER[t]})`
                            : "MCP server not connected"
                        }
                      >
                        {t}
                      </span>
                    );
                  })}
                  <span
                    className="rounded bg-amber-100 px-2 py-0.5 font-mono text-[10px] text-amber-800"
                    title="In-process (not MCP) — blocking semantic ties to the runner thread"
                  >
                    request_human_input · in-process
                  </span>
                </div>
              </div>

              {status && (
                <div className="mt-3 text-[11px] text-stone-500">
                  backend: {status.backend} · {status.model}
                </div>
              )}

              {prompts && (
                <details className="mt-3 text-xs text-stone-600">
                  <summary className="cursor-pointer text-stone-500 hover:text-stone-800">
                    system prompt
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-y-auto rounded bg-stone-50 p-3 text-[11px] font-mono whitespace-pre-wrap">
                    {prompts[role]}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
