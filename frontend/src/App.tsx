import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AgentQuestionModal from "./components/AgentQuestionModal";
import AgentTimeline from "./components/AgentTimeline";
import BiomarkerTable from "./components/BiomarkerTable";
import MemoPanel from "./components/MemoPanel";
import TaskGraph from "./components/TaskGraph";
import WorkerDrawer from "./components/WorkerDrawer";
import { streamRun } from "./lib/sse";
import { selectTotalCost, useStore } from "./store";

export default function App() {
  const idea = useStore((s) => s.idea);
  const password = useStore((s) => s.password);
  const phase = useStore((s) => s.phase);
  const error = useStore((s) => s.error);
  const totalCost = useStore(selectTotalCost);
  const prompts = useStore((s) => s.prompts);
  const labPanel = useStore((s) => s.labPanel);
  const labError = useStore((s) => s.labError);
  const labLoading = useStore((s) => s.labLoading);
  const setIdea = useStore((s) => s.setIdea);
  const setPrompts = useStore((s) => s.setPrompts);
  const setTaskId = useStore((s) => s.setTaskId);
  const taskId = useStore((s) => s.taskId);
  const eventLog = useStore((s) => s.eventLog);
  const startFollowUp = useStore((s) => s.startFollowUp);
  const setLabPanel = useStore((s) => s.setLabPanel);
  const setLabError = useStore((s) => s.setLabError);
  const setLabLoading = useStore((s) => s.setLabLoading);
  const startRun = useStore((s) => s.startRun);
  const applyEvent = useStore((s) => s.applyEvent);

  const esRef = useRef<EventSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [labText, setLabText] = useState("");
  const [showLabPaste, setShowLabPaste] = useState(false);

  // Fetch the system prompts once so the expand-drawer can render them.
  useEffect(() => {
    if (prompts) return;
    fetch("/api/prompts")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p && setPrompts(p))
      .catch(() => {});
  }, [prompts, setPrompts]);

  // Attach the SSE stream when this route mounts mid-run — happens when
  // another route (e.g. /check-in weekly synthesis) primed taskId+phase
  // before navigating back here. Without this, the run streams server-side
  // but the home page never picks it up.
  useEffect(() => {
    if (phase !== "running" || !taskId || esRef.current) return;
    esRef.current = streamRun(taskId, (ev) => {
      applyEvent(ev);
      if (ev.type === "task_complete" || ev.type === "error") {
        esRef.current?.close();
        esRef.current = null;
      }
    });
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
    // Only run on mount + when taskId/phase first becomes runnable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, phase]);

  const busy = phase === "running";

  const submitAnswer = async (request_id: string, answer: string) => {
    if (!taskId) return;
    try {
      await fetch(`/api/run/${taskId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id, answer, password }),
      });
    } catch {
      // Swallow — if the answer POST fails the agent will time out and
      // proceed with its default ("use your best judgment").
    }
  };

  const uploadLabs = async (formData: FormData) => {
    formData.set("password", password);
    setLabLoading(true);
    setLabError("");
    try {
      const res = await fetch("/api/labs", { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLabError(body.detail || `HTTP ${res.status}`);
        return;
      }
      const panel = await res.json();
      setLabPanel(panel);
    } catch (err) {
      setLabError(String(err));
    } finally {
      setLabLoading(false);
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    await uploadLabs(fd);
    // reset so the same file can be re-picked
    e.target.value = "";
  };

  const onSubmitLabText = async () => {
    if (!labText.trim()) return;
    const fd = new FormData();
    fd.set("text", labText.trim());
    await uploadLabs(fd);
    setLabText("");
    setShowLabPaste(false);
  };

  const runFollowUp = async (note: string) => {
    if (!taskId) return;
    startFollowUp();
    try {
      const res = await fetch(`/api/run/${taskId}/follow_up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        applyEvent({ type: "error", text: body.detail || `HTTP ${res.status}` });
        return;
      }
      const { task_id } = await res.json();
      setTaskId(task_id);
      esRef.current?.close();
      esRef.current = streamRun(task_id, (ev) => {
        applyEvent(ev);
        if (ev.type === "task_complete" || ev.type === "error") {
          esRef.current?.close();
        }
      });
    } catch (err) {
      applyEvent({ type: "error", text: String(err) });
    }
  };

  const run = async () => {
    if (!idea.trim() || busy) return;
    startRun();
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea,
          password,
          biomarkers: labPanel?.biomarkers ?? null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        applyEvent({ type: "error", text: body.detail || `HTTP ${res.status}` });
        return;
      }
      const { task_id } = await res.json();
      setTaskId(task_id);
      esRef.current?.close();
      esRef.current = streamRun(task_id, (ev) => {
        applyEvent(ev);
        if (ev.type === "task_complete" || ev.type === "error") {
          esRef.current?.close();
        }
      });
    } catch (err) {
      applyEvent({ type: "error", text: String(err) });
    }
  };

  const showCost = totalCost > 0;

  return (
    <div className="px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="font-serif text-2xl text-stone-900">
              Personalized Health Team
            </h1>
            <p className="text-sm text-stone-500">
              A four-agent CAMEL Workforce — research, assessment, safety review, plan.
            </p>
          </div>
          {showCost && (
            <div className="text-right font-mono text-xs text-stone-500">
              <div className="uppercase tracking-wide text-[10px] text-stone-400">
                cost so far
              </div>
              <div className="text-lg text-stone-800">
                ${totalCost.toFixed(4)}
              </div>
            </div>
          )}
        </header>

        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Educational information only — not medical advice, and not a substitute
          for a qualified healthcare professional. Seek prompt care for any
          concerning symptoms.
        </div>

        <div className="mb-5 flex gap-2">
          <input
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="Describe yourself — age, lifestyle, goals, any concerns. e.g. 34, desk job, want more energy and to lose 10 lbs, mild back pain"
            disabled={busy}
            className="flex-1 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-50"
          />
          <button
            onClick={run}
            disabled={busy || !idea.trim()}
            className="rounded-md bg-stone-900 px-6 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
          >
            {phase === "running" ? "Running…" : "Run"}
          </button>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-3 text-xs text-stone-600">
          <span className="text-stone-500">Optional — attach a lab report:</span>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || labLoading}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 hover:bg-stone-50 disabled:opacity-40"
          >
            📄 Upload PDF
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={onPickFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => setShowLabPaste((v) => !v)}
            disabled={busy || labLoading}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 hover:bg-stone-50 disabled:opacity-40"
          >
            📋 Paste text
          </button>
          {labLoading && <span className="text-stone-500">parsing…</span>}
          {labError && (
            <span className="text-red-600">labs: {labError}</span>
          )}
        </div>

        {showLabPaste && (
          <div className="mb-5 rounded-md border border-stone-200 bg-white p-3">
            <textarea
              value={labText}
              onChange={(e) => setLabText(e.target.value)}
              placeholder="Paste lab values here. e.g.&#10;Vitamin D, 25-Hydroxy   18  ng/mL  (ref 30-100)  LOW&#10;Hemoglobin A1c   5.9  %   (ref <5.7)  HIGH"
              rows={6}
              className="w-full resize-y rounded border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] outline-none focus:border-stone-400"
            />
            <div className="mt-2 flex justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => {
                  setLabText("");
                  setShowLabPaste(false);
                }}
                className="text-stone-500 hover:text-stone-800"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={onSubmitLabText}
                disabled={!labText.trim() || labLoading}
                className="rounded-md bg-stone-900 px-3 py-1.5 text-white hover:bg-stone-700 disabled:opacity-40"
              >
                Parse
              </button>
            </div>
          </div>
        )}

        <BiomarkerTable />

        {phase === "error" && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <TaskGraph />

        {phase === "running" && eventLog.length > 0 && (
          <details className="mt-6" open>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-stone-500 hover:text-stone-800">
              live timeline · {eventLog.length} event
              {eventLog.length === 1 ? "" : "s"}
            </summary>
            <div className="mt-2">
              <AgentTimeline events={eventLog} />
            </div>
          </details>
        )}

        <div className="mt-6">
          <MemoPanel onFollowUp={runFollowUp} />
        </div>

        {taskId && phase === "done" && (
          <div className="mt-3 text-center">
            <Link
              to={`/runs/${taskId}/timeline`}
              className="inline-block rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
            >
              View full timeline →
            </Link>
          </div>
        )}

        <p className="mt-3 text-center text-[11px] text-stone-400">
          Click any worker node to see its system prompt, streamed output, tool
          calls, and usage.
        </p>
      </div>

      <WorkerDrawer />
      <AgentQuestionModal onAnswer={submitAnswer} />
    </div>
  );
}
