import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import CommandPalette from "./components/CommandPalette";
import Gate from "./components/Gate";
import OnboardingModal from "./components/OnboardingModal";
import { useAuthStatus, useModelStatus } from "./lib/queries";
import { useStore } from "./store";

const nav = [
  { to: "/", label: "Run" },
  { to: "/agents", label: "Agents" },
  { to: "/check-in", label: "Check-in" },
  { to: "/memory-graph", label: "Memory" },
  { to: "/evals", label: "Evals" },
  { to: "/settings", label: "Settings" },
];

export default function Layout() {
  const authed = useStore((s) => s.authed);
  const setAuthed = useStore((s) => s.setAuthed);
  const { data: auth } = useAuthStatus();
  const { data: status } = useModelStatus();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-authenticate when the backend reports no password is required —
  // this is the default for local/desktop builds.
  useEffect(() => {
    if (auth && !auth.required && !authed) setAuthed(true);
  }, [auth, authed, setAuthed]);

  if (auth?.required && !authed) return <Gate />;

  const onboardingNeeded =
    status !== undefined && status.has_usable_backend === false;

  return (
    <div className="min-h-screen bg-cloud-canvas text-ink-black">
      <header className="sticky top-0 z-30 border-b border-frost-gray bg-cloud-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-3">
          <Link
            to="/"
            className="text-[15px] font-semibold tracking-tight text-ink-black"
          >
            HealthOS
          </Link>
          <nav className="flex items-center gap-1 text-[13px]">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                className={({ isActive }) =>
                  "rounded-default px-3 py-1.5 transition-colors " +
                  (isActive
                    ? "bg-ink-black text-paper-white"
                    : "text-slate-gray hover:bg-paper-white hover:text-ink-black")
                }
              >
                {n.label}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="ml-2 rounded-default border border-frost-gray bg-paper-white/5 px-2 py-1 font-mono text-[11px] text-slate-gray hover:bg-paper-white/10 hover:text-ink-black"
              title="Command palette"
            >
              ⌘K
            </button>
          </nav>
          {status && (
            <div className="text-right font-mono text-[11px] text-slate-gray">
              <div className="uppercase tracking-wider text-silver-mist">
                backend
              </div>
              <div className="text-ink-black">
                {status.backend} · {status.model}
              </div>
            </div>
          )}
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      {onboardingNeeded && <OnboardingModal />}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={(path) => {
          setPaletteOpen(false);
          navigate(path);
        }}
      />
    </div>
  );
}
