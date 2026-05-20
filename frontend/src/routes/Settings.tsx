import { useState } from "react";
import {
  useMCPServers,
  useModelStatus,
  useReconnectMCP,
  useUpdateModel,
} from "../lib/queries";
import { useStore } from "../store";

type Tab = "model" | "mcp" | "data";

export default function Settings() {
  const [tab, setTab] = useState<Tab>("model");

  return (
    <div className="px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 font-serif text-2xl text-stone-900">Settings</h1>
        <p className="mb-5 text-sm text-stone-500">
          Configure the model backend, inspect MCP servers, and manage local
          data.
        </p>

        <div className="mb-5 flex gap-1 border-b border-stone-200">
          {(["model", "mcp", "data"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                "border-b-2 px-3 py-2 text-sm capitalize transition-colors " +
                (tab === t
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-700")
              }
            >
              {t === "mcp" ? "MCP servers" : t}
            </button>
          ))}
        </div>

        {tab === "model" && <ModelTab />}
        {tab === "mcp" && <MCPTab />}
        {tab === "data" && <DataTab />}
      </div>
    </div>
  );
}

function ModelTab() {
  const password = useStore((s) => s.password);
  const { data: status } = useModelStatus();
  const update = useUpdateModel();
  const [openaiModel, setOpenaiModel] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaHost, setOllamaHost] = useState("");
  const [error, setError] = useState("");

  if (!status) return <div className="text-sm text-stone-500">loading…</div>;

  const submit = async (backend: "openai" | "ollama") => {
    setError("");
    try {
      await update.mutateAsync({
        password,
        backend,
        openai_model: openaiModel || undefined,
        ollama_model: ollamaModel || undefined,
        ollama_host: ollamaHost || undefined,
      });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-stone-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-400">
              Active backend
            </div>
            <div className="font-mono text-sm text-stone-900">
              {status.backend} · {status.model}
            </div>
          </div>
          <div className="text-right text-[11px] text-stone-500">
            <div>OpenAI key: {status.openai_key_set ? "✓" : "—"}</div>
            <div>Ollama reachable: {status.ollama_reachable ? "✓" : "—"}</div>
          </div>
        </div>
      </div>

      <Section title="OpenAI · cloud-default">
        <label className="block text-xs text-stone-600">
          Model
          <input
            value={openaiModel}
            onChange={(e) => setOpenaiModel(e.target.value)}
            placeholder={status.openai_model}
            className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-stone-500"
          />
        </label>
        <button
          type="button"
          onClick={() => submit("openai")}
          disabled={update.isPending}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
        >
          Use OpenAI
        </button>
      </Section>

      <Section title="Ollama · local opt-in">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-stone-600">
            Host
            <input
              value={ollamaHost}
              onChange={(e) => setOllamaHost(e.target.value)}
              placeholder={status.ollama_host}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </label>
          <label className="block text-xs text-stone-600">
            Model
            <input
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              placeholder={status.ollama_model}
              className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => submit("ollama")}
          disabled={update.isPending}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
        >
          Use local Ollama
        </button>
      </Section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}

function MCPTab() {
  const password = useStore((s) => s.password);
  const { data: servers } = useMCPServers();
  const reconnect = useReconnectMCP();

  if (!servers) return <div className="text-sm text-stone-500">loading…</div>;

  return (
    <div className="space-y-3">
      {servers.map((s) => {
        const color =
          s.status === "connected"
            ? "bg-green-100 text-green-800"
            : s.status === "disabled"
              ? "bg-stone-100 text-stone-600"
              : "bg-amber-100 text-amber-800";
        return (
          <div
            key={s.name}
            className="rounded-md border border-stone-200 bg-white p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-sm text-stone-900">{s.name}</div>
                <div className="mt-1 text-[11px] text-stone-500">
                  {s.error || (s.tools.length === 0 ? "no tools" : `${s.tools.length} tools`)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${color}`}
                >
                  {s.status}
                </span>
                {s.status !== "disabled" && (
                  <button
                    type="button"
                    onClick={() => reconnect.mutate({ name: s.name, password })}
                    disabled={reconnect.isPending}
                    className="rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40"
                  >
                    Reconnect
                  </button>
                )}
              </div>
            </div>
            {s.tools.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {s.tools.map((t) => (
                  <span
                    key={t.name}
                    className="rounded bg-stone-100 px-2 py-0.5 font-mono text-[10px] text-stone-700"
                    title={t.description}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DataTab() {
  const password = useStore((s) => s.password);
  const [wipeText, setWipeText] = useState("");
  const [wipeBusy, setWipeBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const exportDb = () => {
    // Plain anchor click — the GET endpoint streams the file as octet-stream.
    const url = `/api/data/export?password=${encodeURIComponent(password)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "healthos.db";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const wipe = async () => {
    setMessage(null);
    setWipeBusy(true);
    try {
      const r = await fetch("/api/data/wipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirm: wipeText }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
      setMessage({
        kind: "ok",
        text: `Wiped: ${(body.deleted as string[]).join(", ") || "(empty)"}`,
      });
      setWipeText("");
    } catch (e) {
      setMessage({ kind: "err", text: String(e) });
    } finally {
      setWipeBusy(false);
    }
  };

  const openDataDir = () => {
    const w = window as unknown as { healthos?: { openDataDir?: () => void } };
    if (w.healthos?.openDataDir) {
      w.healthos.openDataDir();
    } else {
      setMessage({
        kind: "err",
        text: "Open in Finder is only available in the Electron build. Path: ~/.healthos/",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-stone-200 bg-white p-4 text-sm text-stone-600">
        <p>
          Local data lives at{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5">~/.healthos/</code> —
          SQLite DB, embedded Chroma vector store, and the notes directory the
          filesystem MCP server reads from.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={exportDb}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
        >
          Export DB
        </button>
        <button
          type="button"
          onClick={openDataDir}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
        >
          Open data folder
        </button>
      </div>

      <div className="rounded-md border border-red-200 bg-red-50/40 p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-red-700">
          Danger zone
        </div>
        <p className="mt-1 text-sm text-stone-700">
          Wipe all local data — DB, vector store, notes. Type{" "}
          <code className="rounded bg-stone-200 px-1">WIPE</code> to confirm.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={wipeText}
            onChange={(e) => setWipeText(e.target.value)}
            placeholder="WIPE"
            className="flex-1 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-stone-500"
          />
          <button
            type="button"
            onClick={wipe}
            disabled={wipeText !== "WIPE" || wipeBusy}
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-40"
          >
            {wipeBusy ? "Wiping…" : "Wipe local data"}
          </button>
        </div>
      </div>

      {message && (
        <div
          className={
            "rounded-md border px-3 py-2 text-xs " +
            (message.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800")
          }
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md border border-stone-200 bg-white p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-stone-500">
        {title}
      </div>
      {children}
    </div>
  );
}
