import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AgentQuestionModal from "./components/AgentQuestionModal";
import AgentTimeline from "./components/AgentTimeline";
import BiomarkerTable from "./components/BiomarkerTable";
import MemoPanel from "./components/MemoPanel";
import TaskGraph from "./components/TaskGraph";
import WorkerDrawer from "./components/WorkerDrawer";
import { Button } from "./components/ui/Button";
import { Card } from "./components/ui/Card";
import { Input, Textarea } from "./components/ui/Input";
import { api } from "./lib/api";
import { useProfileSynthesis } from "./lib/queries";
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

  useEffect(() => {
    if (prompts) return;
    fetch("/api/prompts")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p && setPrompts(p))
      .catch(() => {});
  }, [prompts, setPrompts]);

  // Hydrate the most recent persisted lab panel so reloads don't drop labs.
  useEffect(() => {
    if (labPanel) return;
    api
      .recentBiomarkers()
      .then((rows) => {
        if (!rows.length) return;
        setLabPanel({
          lab_name: null,
          date: null,
          biomarkers: rows.map((r) => ({
            name: r.name,
            value: r.value,
            unit: r.unit,
            reference_range: null,
            flag: (r.flag as "normal" | "low" | "high" | "unknown") ?? "unknown",
          })),
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      /* timeout falls back to "use your best judgment" */
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
        {/* Hero — Firecrawl's centered headline on Paper White with the
            full Feature-Card shadow. Single Fire Orange "active" stripe. */}
        <Card surface="hero" className="relative mb-6 overflow-hidden">
          <div className="flex items-center gap-2 text-caption uppercase tracking-[0.1px] text-slate-gray">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-fire-orange" />
            Personalized Health Team
          </div>
          <h1 className="mt-2 text-heading font-medium text-ink-black">
            Four agents. One plan.
          </h1>
          <p className="mt-2 max-w-xl text-body text-slate-gray">
            A CAMEL Workforce — research, assessment, safety review, plan — over a curated knowledge graph and your personal context.
          </p>
          {showCost && (
            <div className="absolute right-6 top-6 text-right font-mono">
              <div className="text-caption uppercase tracking-[0.1px] text-silver-mist">
                cost so far
              </div>
              <div className="text-subheading text-ink-black">
                ${totalCost.toFixed(4)}
              </div>
            </div>
          )}
        </Card>

        <Card surface="canvas" shape="default" className="mb-5 border border-pale-sienna bg-pale-sienna/40">
          <p className="text-body leading-relaxed text-stone-gray">
            <span className="font-medium text-ink-black">Educational information only</span>{" "}
            — not medical advice, and not a substitute for a qualified
            healthcare professional. Seek prompt care for any concerning symptoms.
          </p>
        </Card>

        <ProfileLoadedHint />
        <div className="mb-5 flex gap-2">
          <Input
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="What do you want help with? e.g. 'Help me sleep better this week' · 'Lower my LDL over the next 3 months' · 'I have new lower back pain — what should I try first?'"
            disabled={busy}
          />
          <Button
            onClick={run}
            disabled={busy || !idea.trim()}
            size="lg"
          >
            {phase === "running" ? "Running…" : "Ask"}
          </Button>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-3 text-[12px] text-slate-gray">
          <span>Optional — attach a lab report:</span>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || labLoading}
          >
            Upload PDF
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={onPickFile}
            className="hidden"
          />
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setShowLabPaste((v) => !v)}
            disabled={busy || labLoading}
          >
            Paste text
          </Button>
          {labLoading && <span>parsing…</span>}
          {labError && <span className="text-status-error">labs: {labError}</span>}
        </div>

        {showLabPaste && (
          <Card surface="starless" shape="default" className="mb-5">
            <Textarea
              value={labText}
              onChange={(e) => setLabText(e.target.value)}
              placeholder="Paste lab values here. e.g.&#10;Vitamin D, 25-Hydroxy   18  ng/mL  (ref 30-100)  LOW&#10;Hemoglobin A1c   5.9  %   (ref <5.7)  HIGH"
              rows={6}
              className="font-mono text-[11px]"
            />
            <div className="mt-2 flex justify-end gap-2 text-[12px]">
              <Button
                variant="subtle"
                size="sm"
                type="button"
                onClick={() => {
                  setLabText("");
                  setShowLabPaste(false);
                }}
              >
                cancel
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={onSubmitLabText}
                disabled={!labText.trim() || labLoading}
              >
                Parse
              </Button>
            </div>
          </Card>
        )}

        <BiomarkerTable />

        {phase === "error" && (
          <Card surface="starless" shape="default" className="mb-4 border border-status-error/40 bg-status-error/10 text-status-error">
            <p className="text-body">{error}</p>
          </Card>
        )}

        <TaskGraph />

        {phase === "running" && eventLog.length > 0 && (
          <details className="mt-6" open>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-slate-gray hover:text-ink-black">
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
              className="inline-block rounded-pill border border-frost-gray bg-paper-white/5 px-3 py-1.5 text-[12px] text-stone-gray hover:bg-paper-white/10 hover:text-ink-black"
            >
              View full timeline →
            </Link>
          </div>
        )}

        <p className="mt-3 text-center text-[11px] text-silver-mist">
          Click any worker node to see its system prompt, streamed output, tool
          calls, and usage.
        </p>
      </div>

      <WorkerDrawer />
      <AgentQuestionModal onAnswer={submitAnswer} />
    </div>
  );
}

function ProfileLoadedHint() {
  const { data } = useProfileSynthesis();
  const hasSynthesis = !!data?.notes?.trim();
  return (
    <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-gray">
      <span
        aria-hidden
        className={
          "inline-block h-1.5 w-1.5 rounded-full " +
          (hasSynthesis ? "bg-status-success" : "bg-silver-mist")
        }
      />
      {hasSynthesis ? (
        <span>
          Your profile is loaded — the agents already know about your check-ins,
          past plans, and labs. Just ask the question.{" "}
          <Link
            to="/memory"
            className="text-stone-gray underline-offset-2 hover:text-ink-black hover:underline"
          >
            See what they know →
          </Link>
        </span>
      ) : (
        <span>
          No profile synthesis yet. Log a{" "}
          <Link to="/today" className="text-stone-gray underline-offset-2 hover:text-ink-black hover:underline">
            check-in
          </Link>{" "}
          first, or describe yourself in the prompt below.
        </span>
      )}
    </div>
  );
}
