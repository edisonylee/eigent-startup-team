// Monthly calendar of logged events, with click-to-add retroactive logging.
// Sits above the TaskGraph on the home page. The visible month is owned by
// App.tsx and passed down so the TrendChart underneath stays in lockstep.

import { useMemo, useState } from "react";
import { EVENT_CATEGORIES, EventCategory, LoggedEvent } from "../lib/api";
import {
  useDeleteEvent,
  useEvents,
  useLogEvent,
} from "../lib/queries";
import { useStore } from "../store";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Dialog, DialogContent, DialogTitle } from "./ui/Dialog";
import { Input, Textarea } from "./ui/Input";

/** Tailwind bg-class per category. 8 distinct hues from Firecrawl's palette.
 *  Vivid colors map to the high-signal categories (symptoms, meals, sleep,
 *  exercise) and softer tints + neutrals trail behind for ambient logging. */
export const CATEGORY_COLOR: Record<EventCategory, string> = {
  symptom: "bg-status-error",   // red
  meal: "bg-fire-orange",       // orange
  sleep: "bg-code-blue",        // blue
  exercise: "bg-status-done",   // green
  supplement: "bg-pale-sienna", // soft peach
  medication: "bg-powder-pink", // soft pink
  mood: "bg-stone-gray",        // dark neutral
  note: "bg-silver-mist",       // mid neutral
};

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

export interface MonthGrid {
  /** 42 cells (6 weeks × 7 days), oldest → newest, padded with prev/next month days. */
  cells: { day: string; inMonth: boolean }[];
  /** First day of the visible month (YYYY-MM-DD) — used as `since` for the query. */
  start: string;
  /** Last day of the visible month — used as `until`. */
  end: string;
  /** Human label, e.g. "May 2026". */
  label: string;
}

/** Build the 6×7 monthly grid for the given (year, month-0-indexed). */
export function monthGrid(year: number, month: number): MonthGrid {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startWeekday = first.getDay(); // 0 = Sun
  const cells: { day: string; inMonth: boolean }[] = [];

  // Leading days from previous month.
  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ day: formatDay(d), inMonth: false });
  }
  // This month's days.
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push({ day: formatDay(new Date(year, month, d)), inMonth: true });
  }
  // Trailing days from next month to reach exactly 42 cells.
  let trailing = 1;
  while (cells.length < 42) {
    cells.push({
      day: formatDay(new Date(year, month + 1, trailing)),
      inMonth: false,
    });
    trailing++;
  }

  return {
    cells,
    start: formatDay(first),
    end: formatDay(last),
    label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

export function formatDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Props {
  year: number;
  month: number; // 0-indexed
  onChange: (year: number, month: number) => void;
}

export default function CalendarStrip({ year, month, onChange }: Props) {
  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  // Query the visible month plus the leading/trailing padding days so cells
  // outside this month can still show their dots.
  const { data: events } = useEvents({
    since: grid.cells[0].day,
    until: grid.cells[grid.cells.length - 1].day,
    limit: 1000,
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, LoggedEvent[]>();
    for (const e of events || []) {
      const arr = m.get(e.day) || [];
      arr.push(e);
      m.set(e.day, arr);
    }
    return m;
  }, [events]);

  const today = formatDay(new Date());

  const goPrev = () => {
    const d = new Date(year, month - 1, 1);
    onChange(d.getFullYear(), d.getMonth());
  };
  const goNext = () => {
    const d = new Date(year, month + 1, 1);
    onChange(d.getFullYear(), d.getMonth());
  };
  const goToday = () => {
    const d = new Date();
    onChange(d.getFullYear(), d.getMonth());
  };

  // Weekday header derived from the first row.
  const weekdayLabels = grid.cells.slice(0, 7).map((c) =>
    new Date(c.day + "T12:00:00").toLocaleDateString(undefined, {
      weekday: "short",
    }),
  );

  return (
    <Card surface="paper" className="mb-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="subtle" size="sm" onClick={goPrev} aria-label="Previous month">
            ←
          </Button>
          <button
            type="button"
            onClick={goToday}
            className="rounded-default px-2 py-1 text-subheading font-semibold text-ink-black hover:bg-paper-white"
            title="Jump to current month"
          >
            {grid.label}
          </button>
          <Button variant="subtle" size="sm" onClick={goNext} aria-label="Next month">
            →
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelectedDay(today)}
        >
          + Log event
        </Button>
      </div>

      <div className="mb-2 grid grid-cols-7 gap-1 px-0.5 text-center text-[10px] font-medium uppercase tracking-wider text-stone-gray">
        {weekdayLabels.map((w, i) => (
          <div key={i}>{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {grid.cells.map(({ day, inMonth }) => {
          const dayEvents = byDay.get(day) || [];
          const isToday = day === today;
          const cats = uniqueCategories(dayEvents);

          let cellClass =
            "group relative flex aspect-square flex-col items-stretch " +
            "justify-between rounded-default border p-1.5 text-left " +
            "transition-[background,border-color,box-shadow] ";

          if (isToday) {
            cellClass +=
              "border-fire-orange bg-fire-orange/10 hover:bg-fire-orange/15";
          } else if (inMonth) {
            cellClass +=
              "border-frost-gray bg-elevated-white hover:border-fire-orange/50 hover:bg-fire-orange/[0.04]";
          } else {
            // Out-of-month: tucked back, still clickable for retroactive log.
            cellClass +=
              "border-transparent bg-paper-white opacity-50 hover:opacity-80";
          }

          return (
            <button
              key={day}
              type="button"
              onClick={() => setSelectedDay(day)}
              className={cellClass}
              title={`${day} — ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className={
                    "font-medium text-[11px] " +
                    (inMonth ? "text-ink-black" : "text-silver-mist")
                  }
                >
                  {parseInt(day.split("-")[2], 10)}
                </span>
                {dayEvents.length > 4 && (
                  <span className="font-mono text-[9px] text-stone-gray">
                    +{dayEvents.length - 4}
                  </span>
                )}
              </div>
              <div className="mt-auto flex flex-wrap gap-1">
                {cats.slice(0, 4).map((c) => (
                  <span
                    key={c}
                    className={`h-2 w-2 rounded-full ${CATEGORY_COLOR[c]}`}
                    title={CATEGORY_LABEL[c]}
                  />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <DayEventsModal
        day={selectedDay}
        onClose={() => setSelectedDay(null)}
        events={selectedDay ? byDay.get(selectedDay) || [] : []}
      />
    </Card>
  );
}

function uniqueCategories(events: LoggedEvent[]): EventCategory[] {
  const seen = new Set<EventCategory>();
  const order: EventCategory[] = [];
  for (const e of events) {
    if (!seen.has(e.category)) {
      seen.add(e.category);
      order.push(e.category);
    }
  }
  return order;
}

function DayEventsModal({
  day,
  events,
  onClose,
}: {
  day: string | null;
  events: LoggedEvent[];
  onClose: () => void;
}) {
  const password = useStore((s) => s.password);
  const log = useLogEvent();
  const del = useDeleteEvent();

  const [category, setCategory] = useState<EventCategory>("symptom");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [date, setDate] = useState<string>("");
  const [error, setError] = useState("");

  const open = day != null;
  if (open && date !== day) {
    setDate(day!);
    setDescription("");
    setTags("");
    setError("");
  }

  const submit = async () => {
    if (!description.trim()) {
      setError("Add a description.");
      return;
    }
    setError("");
    try {
      await log.mutateAsync({
        password,
        category,
        description: description.trim(),
        day: date,
        tags: tags
          ? tags.split(",").map((t) => t.trim()).filter(Boolean)
          : [],
      });
      setDescription("");
      setTags("");
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await del.mutateAsync({ id, password });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto bg-paper-white p-6">
        <DialogTitle className="text-subheading font-semibold text-ink-black">
          {day ? prettyDay(day) : "Log event"}
        </DialogTitle>
        <p className="mt-0.5 text-[12px] text-slate-gray">
          {events.length === 0
            ? "Nothing logged yet."
            : `${events.length} event${events.length === 1 ? "" : "s"} on this day.`}
        </p>

        {events.length > 0 && (
          <ul className="mt-4 space-y-2">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex items-start gap-2 rounded-default border border-frost-gray bg-elevated-white p-3"
              >
                <span
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${CATEGORY_COLOR[e.category]}`}
                  title={e.category}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-wider text-stone-gray">
                    {CATEGORY_LABEL[e.category]}
                  </div>
                  <div className="mt-0.5 text-[13px] text-ink-black">
                    {e.description}
                  </div>
                  {e.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {e.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded-pill border border-frost-gray px-2 py-0.5 font-mono text-[9px] text-stone-gray"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(e.id)}
                  className="text-[10px] uppercase tracking-wider text-slate-gray hover:text-status-error"
                  title="Delete event"
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 space-y-3 border-t border-frost-gray pt-4">
          <div className="text-[10px] uppercase tracking-wider text-stone-gray">
            Add event
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[11px] text-stone-gray">Date</span>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 font-mono text-[12px]"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-stone-gray">Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as EventCategory)}
                className="mt-1 w-full rounded-default border border-frost-gray bg-elevated-white px-3 py-2 text-body text-ink-black outline-none focus:border-fire-orange/60"
              >
                {EVENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <Textarea
            placeholder="What happened? e.g. 5 mile run, sharp lower-back twinge after sitting, took mag 200mg…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="text-[13px]"
          />

          <Input
            placeholder="Tags (optional, comma-separated): back, evening, mag-200"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="font-mono text-[11px]"
          />

          {error && (
            <div className="rounded-default border border-status-error/40 bg-status-error/10 px-3 py-2 text-[12px] text-status-error">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="subtle" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              size="sm"
              onClick={submit}
              disabled={log.isPending || !description.trim()}
            >
              {log.isPending ? "Logging…" : "Log event"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function prettyDay(day: string): string {
  const d = new Date(day + "T12:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
