import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, CheckIn as CheckInRow } from "../lib/api";
import { useAddCheckIn, useCheckIns, useRuns } from "../lib/queries";
import { useStore } from "../store";

const SCALE = [1, 2, 3, 4, 5];

export default function CheckIn() {
  const password = useStore((s) => s.password);
  const setTaskId = useStore((s) => s.setTaskId);
  const startFollowUp = useStore((s) => s.startFollowUp);
  const { data: checkIns } = useCheckIns();
  const { data: runs } = useRuns(10);
  const add = useAddCheckIn();
  const navigate = useNavigate();
  const [energy, setEnergy] = useState<number | null>(null);
  const [sleep, setSleep] = useState<string>("");
  const [mood, setMood] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [synthLoading, setSynthLoading] = useState(false);

  const lastDoneRun = runs?.find((r) => r.status === "done" && r.memo);
  const recentSeven = (checkIns || []).slice(0, 7);
  const canSynthesize = lastDoneRun && recentSeven.length > 0;

  const runWeeklySynthesis = async () => {
    if (!lastDoneRun) return;
    setError("");
    setSynthLoading(true);
    try {
      const note = buildSynthesisNote(recentSeven);
      const res = await api.run(lastDoneRun.task_id).catch(() => null);
      if (!res) throw new Error("source run not found");
      const followUp = await fetch(
        `/api/run/${lastDoneRun.task_id}/follow_up`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note, password }),
        },
      );
      if (!followUp.ok) {
        const body = await followUp.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${followUp.status}`);
      }
      const { task_id } = await followUp.json();
      // Prime the store so the home page picks up the new run + streams.
      setTaskId(task_id);
      startFollowUp();
      navigate("/");
    } catch (e) {
      setError(String(e));
    } finally {
      setSynthLoading(false);
    }
  };

  const submit = async () => {
    setError("");
    try {
      await add.mutateAsync({
        password,
        energy: energy ?? undefined,
        sleep_hours: sleep ? parseFloat(sleep) : undefined,
        mood: mood ?? undefined,
        adherence_notes: notes || undefined,
      });
      setEnergy(null);
      setSleep("");
      setMood(null);
      setNotes("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 font-serif text-2xl text-stone-900">Daily check-in</h1>
        <p className="mb-5 text-sm text-stone-500">
          Log how you feel today. The Workforce can synthesize the last week
          into a follow-up plan adjustment.
        </p>

        <div className="space-y-5 rounded-lg border border-stone-200 bg-white p-5">
          <Scale
            label="Energy"
            value={energy}
            setValue={setEnergy}
            hint="1 = drained, 5 = great"
          />
          <Scale
            label="Mood"
            value={mood}
            setValue={setMood}
            hint="1 = low, 5 = bright"
          />
          <label className="block text-xs text-stone-600">
            Sleep (hours)
            <input
              type="number"
              step={0.25}
              min={0}
              max={16}
              value={sleep}
              onChange={(e) => setSleep(e.target.value)}
              className="mt-1 w-32 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-stone-500"
            />
          </label>
          <label className="block text-xs text-stone-600">
            Adherence notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What stuck? What didn't? Any new symptoms?"
              className="mt-1 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={add.isPending}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
          >
            {add.isPending ? "Saving…" : "Log check-in"}
          </button>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="mt-8 rounded-lg border border-stone-200 bg-white p-5">
          <h2 className="font-serif text-lg text-stone-900">
            Weekly synthesis
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            Feed the last seven check-ins into a follow-up of your most recent
            plan. The Safety Reviewer + Plan Writer re-run with the new context
            (≈1/10th of a full run cost).
          </p>
          {!lastDoneRun && (
            <p className="mt-2 text-xs text-amber-700">
              You need a completed plan first. Run one from{" "}
              <code className="rounded bg-amber-50 px-1">/</code>.
            </p>
          )}
          {lastDoneRun && recentSeven.length === 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Log at least one check-in before running the synthesis.
            </p>
          )}
          <button
            type="button"
            onClick={runWeeklySynthesis}
            disabled={!canSynthesize || synthLoading}
            className="mt-3 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-40"
          >
            {synthLoading ? "Starting…" : "Run weekly synthesis"}
          </button>
        </div>

        <h2 className="mb-2 mt-8 font-serif text-lg text-stone-900">
          Recent check-ins
        </h2>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          {checkIns && checkIns.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-[10px] uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="px-3 py-2 text-left">Day</th>
                  <th className="px-3 py-2 text-right">Energy</th>
                  <th className="px-3 py-2 text-right">Sleep</th>
                  <th className="px-3 py-2 text-right">Mood</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {checkIns.map((c) => (
                  <tr key={c.id} className="border-t border-stone-100">
                    <td className="px-3 py-2 font-mono text-xs text-stone-700">
                      {c.day}
                    </td>
                    <td className="px-3 py-2 text-right">{c.energy ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{c.sleep_hours ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{c.mood ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-600">
                      {c.adherence_notes || ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-3 py-5 text-center text-xs text-stone-400">
              No check-ins yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildSynthesisNote(checkIns: CheckInRow[]): string {
  // Newest-first → oldest-first so the trend reads naturally to the LLM.
  const rows = [...checkIns].reverse();
  const days = rows.length;
  const avg = (k: "energy" | "mood") => {
    const vals = rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
    if (vals.length === 0) return null;
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  };
  const sleeps = rows
    .map((r) => r.sleep_hours)
    .filter((v): v is number => typeof v === "number");
  const avgSleep =
    sleeps.length > 0
      ? (sleeps.reduce((a, b) => a + b, 0) / sleeps.length).toFixed(1)
      : null;

  const lines: string[] = [
    `Weekly synthesis: ${days} check-in${days === 1 ? "" : "s"} over the last ${days} day${days === 1 ? "" : "s"}.`,
    "",
    `Averages: energy ${avg("energy") ?? "n/a"}/5, mood ${avg("mood") ?? "n/a"}/5, sleep ${avgSleep ?? "n/a"} h.`,
    "",
    "Day-by-day:",
  ];
  for (const r of rows) {
    const bits = [
      `${r.day}`,
      r.energy != null ? `energy ${r.energy}/5` : "",
      r.sleep_hours != null ? `${r.sleep_hours}h sleep` : "",
      r.mood != null ? `mood ${r.mood}/5` : "",
      r.adherence_notes ? `notes: ${r.adherence_notes}` : "",
    ].filter(Boolean);
    lines.push(`  - ${bits.join(" · ")}`);
  }
  lines.push("");
  lines.push(
    "Re-review the existing plan with this weekly context and adjust where the trend warrants.",
  );
  return lines.join("\n");
}

function Scale({
  label,
  value,
  setValue,
  hint,
}: {
  label: string;
  value: number | null;
  setValue: (v: number) => void;
  hint: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-stone-600">
        <span>{label}</span>
        <span className="text-stone-400">{hint}</span>
      </div>
      <div className="mt-1 flex gap-1">
        {SCALE.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setValue(n)}
            className={
              "h-10 w-10 rounded-md border text-sm transition-colors " +
              (value === n
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50")
            }
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
