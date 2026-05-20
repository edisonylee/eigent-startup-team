// Per-category stacked-bar trend strip for the visible month. Lives directly
// under the CalendarStrip and uses the same (year, month) props so a bar
// aligns conceptually with its calendar cell. Hover a day → breakdown line.

import { useMemo, useState } from "react";
import { EVENT_CATEGORIES, EventCategory } from "../lib/api";
import { useCategoryCounts } from "../lib/queries";
import { Card } from "./ui/Card";
import { CATEGORY_COLOR, monthGrid } from "./CalendarStrip";

const CATEGORY_LABEL: Record<EventCategory, string> = {
  symptom: "Symptom",
  meal: "Meal",
  sleep: "Sleep",
  exercise: "Exercise",
  supplement: "Supplement",
  medication: "Medication",
  mood: "Mood",
  note: "Note",
};

// SVG <rect> fills — must visually match CATEGORY_COLOR (which uses
// Tailwind bg-classes pointing at the same CSS vars).
const CATEGORY_FILL: Record<EventCategory, string> = {
  symptom: "var(--color-status-error)",
  meal: "var(--color-fire-orange)",
  sleep: "var(--color-code-blue)",
  exercise: "var(--color-status-done)",
  supplement: "var(--color-pale-sienna)",
  medication: "var(--color-powder-pink)",
  mood: "var(--color-stone-gray)",
  note: "var(--color-silver-mist)",
};

interface Props {
  year: number;
  month: number; // 0-indexed
}

export default function TrendChart({ year, month }: Props) {
  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  // Trend shows only the in-month days (not the leading/trailing padding).
  const days = useMemo(
    () => grid.cells.filter((c) => c.inMonth).map((c) => c.day),
    [grid],
  );
  const { data: counts } = useCategoryCounts(grid.start, grid.end);
  const [hidden, setHidden] = useState<Set<EventCategory>>(new Set());
  const [hover, setHover] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, Map<EventCategory, number>>();
    for (const r of counts || []) {
      const inner = m.get(r.day) || new Map<EventCategory, number>();
      inner.set(r.category, (inner.get(r.category) || 0) + r.n);
      m.set(r.day, inner);
    }
    return m;
  }, [counts]);

  const dayTotal = (day: string): number => {
    const inner = byDay.get(day);
    if (!inner) return 0;
    let total = 0;
    for (const [cat, n] of inner.entries()) {
      if (!hidden.has(cat)) total += n;
    }
    return total;
  };

  const max = Math.max(1, ...days.map(dayTotal));
  const windowTotal = days.reduce((a, d) => a + dayTotal(d), 0);

  // Variable bar width based on day count (28-31) inside a fixed 280px viewBox.
  const colWidth = 280 / days.length;
  const barWidth = Math.max(4, colWidth - 1);
  const barInset = (colWidth - barWidth) / 2;

  return (
    <Card surface="paper" className="mb-5">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-stone-gray">
            Trend · {grid.label}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-gray">
            {windowTotal} event{windowTotal === 1 ? "" : "s"}
          </div>
        </div>
        {hidden.size > 0 && (
          <button
            type="button"
            onClick={() => setHidden(new Set())}
            className="rounded-pill border border-frost-gray px-3 py-1 text-[11px] text-ink-black hover:bg-paper-white"
          >
            Show all
          </button>
        )}
      </div>

      <svg
        viewBox="0 0 280 64"
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label={`${grid.label} stacked event counts`}
        onMouseLeave={() => setHover(null)}
      >
        {/* baseline */}
        <line x1={0} x2={280} y1={62} y2={62} stroke="var(--color-frost-gray)" strokeWidth={0.5} />
        {days.map((day, i) => {
          const inner = byDay.get(day);
          const x = i * colWidth + barInset;
          const total = dayTotal(day);
          if (total === 0) {
            return (
              <rect
                key={day}
                x={x}
                y={61}
                width={barWidth}
                height={1}
                fill="var(--color-frost-gray)"
                onMouseEnter={() => setHover(day)}
              />
            );
          }
          let cursor = 60;
          const segs = EVENT_CATEGORIES.flatMap((cat) => {
            if (hidden.has(cat)) return [];
            const n = inner?.get(cat) || 0;
            if (n === 0) return [];
            const h = (n / max) * 56;
            cursor -= h;
            return [
              <rect
                key={`${day}-${cat}`}
                x={x}
                y={cursor}
                width={barWidth}
                height={h}
                fill={CATEGORY_FILL[cat]}
                opacity={hover && hover !== day ? 0.4 : 1}
              />,
            ];
          });
          return (
            <g key={day} onMouseEnter={() => setHover(day)}>
              {segs}
              <rect
                x={i * colWidth}
                y={0}
                width={colWidth}
                height={62}
                fill="transparent"
              />
            </g>
          );
        })}
      </svg>

      <div className="mt-1 min-h-[18px] font-mono text-[11px] text-slate-gray">
        {hover ? (
          <HoverDetail day={hover} inner={byDay.get(hover)} hidden={hidden} />
        ) : (
          <span className="text-silver-mist">hover a day for a breakdown</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {EVENT_CATEGORIES.map((cat) => {
          const off = hidden.has(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(cat)) next.delete(cat);
                  else next.add(cat);
                  return next;
                })
              }
              className={
                "flex items-center gap-1.5 rounded-pill border px-2 py-0.5 " +
                "text-[10px] transition-[opacity,border-color,background-color] " +
                (off
                  ? "border-frost-gray text-silver-mist opacity-60"
                  : "border-frost-gray bg-elevated-white text-ink-black hover:border-fire-orange/50")
              }
              title={off ? `Show ${cat}` : `Hide ${cat}`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${CATEGORY_COLOR[cat]} ${off ? "opacity-40" : ""}`}
              />
              {CATEGORY_LABEL[cat]}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function HoverDetail({
  day,
  inner,
  hidden,
}: {
  day: string;
  inner: Map<EventCategory, number> | undefined;
  hidden: Set<EventCategory>;
}) {
  const total = inner
    ? Array.from(inner.entries()).reduce(
        (a, [c, n]) => a + (hidden.has(c) ? 0 : n),
        0,
      )
    : 0;
  if (total === 0) {
    return (
      <span>
        <span className="text-ink-black">{day}</span> · no events
      </span>
    );
  }
  const parts = EVENT_CATEGORIES.filter(
    (c) => !hidden.has(c) && (inner?.get(c) || 0) > 0,
  ).map((c) => `${c} ${inner!.get(c)}`);
  return (
    <span>
      <span className="text-ink-black">{day}</span> · {parts.join(" · ")}
    </span>
  );
}
