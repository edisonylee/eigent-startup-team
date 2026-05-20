import { useEffect, useState } from "react";
import { ROLE_LABEL, useStore } from "../store";

interface AgentQuestionModalProps {
  /** Called with the answer to submit; component handles the dismiss + queue. */
  onAnswer: (request_id: string, answer: string) => Promise<void> | void;
}

/**
 * Renders the head of the question queue — the most recent agent that asked
 * for input gets the modal. Submitting (or "use your best judgment") sends
 * an answer to the backend, which resolves the agent's blocking tool call.
 */
export default function AgentQuestionModal({ onAnswer }: AgentQuestionModalProps) {
  const head = useStore((s) => s.questionQueue[0]);
  const dismiss = useStore((s) => s.dismissQuestion);

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset the textarea every time a new question becomes the head.
  useEffect(() => {
    setText("");
    setBusy(false);
  }, [head?.request_id]);

  if (!head) return null;

  const submit = async (answer: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAnswer(head.request_id, answer);
    } finally {
      // Always dismiss so the next queued question can surface, even if the
      // network call failed (the user can resubmit downstream).
      dismiss(head.request_id);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-stone-900/30 p-6 backdrop-blur-sm md:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 shadow-2xl">
        <div className="border-b border-stone-200 bg-white px-6 py-4">
          <div className="text-[10px] uppercase tracking-wider text-amber-700">
            Human-in-the-loop · {ROLE_LABEL[head.role]} needs input
          </div>
          <h2 className="mt-1 font-serif text-lg text-stone-900">
            {head.question}
          </h2>
        </div>

        <div className="space-y-4 px-6 py-5">
          {head.choices.length > 0 ? (
            <div className="flex flex-col gap-2">
              {head.choices.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => submit(c)}
                  disabled={busy}
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-left text-sm text-stone-800 transition-colors hover:border-stone-500 hover:bg-stone-50 disabled:opacity-40"
                >
                  {c}
                </button>
              ))}
            </div>
          ) : (
            <div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(text);
                }}
                placeholder="Your answer… (⌘/Ctrl+Enter to submit)"
                rows={3}
                disabled={busy}
                className="w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:bg-stone-100"
              />
              <button
                type="button"
                onClick={() => submit(text)}
                disabled={!text.trim() || busy}
                className="mt-2 w-full rounded-md bg-stone-900 px-3 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
              >
                {busy ? "Submitting…" : "Submit answer"}
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-stone-200 bg-white px-6 py-3 text-xs">
          <span className="text-stone-500">
            Not sure? Let the agent decide:
          </span>
          <button
            type="button"
            onClick={() => submit("use your best judgment")}
            disabled={busy}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-stone-700 hover:bg-stone-100 disabled:opacity-40"
          >
            Use your best judgment
          </button>
        </div>
      </div>
    </div>
  );
}
