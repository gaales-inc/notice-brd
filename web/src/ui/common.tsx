import { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { LOW_BATTERY_PERCENT } from "../../../shared/style";
import { detectPlatform, Platform } from "../device";
import { promptInstall, useInstall } from "../install";

// ----------------------------------------------------------------------- logo

/** The app's mark: an "N" lit on a grid of LEDs, as on the icon. */
const N_DOTS = ["10001", "11001", "10101", "10011", "10001"];

export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#000" />
      {N_DOTS.map((row, y) =>
        row.split("").map((on, x) => (
          <circle key={`${x}-${y}`} cx={4.4 + x * 3.8} cy={4.4 + y * 3.8} r="1.35" fill={on === "1" ? "#ffc53d" : "#2b2410"} />
        ))
      )}
    </svg>
  );
}

export function Logo() {
  return (
    <span class="logo">
      <Mark />
      <span>
        Notice<b>Brd</b>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------- modal

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not(.modal-x)");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
      previous?.focus?.();
    };
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="icon-button modal-x" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- toast

let showToast: (text: string) => void = () => {};

export function toast(text: string) {
  showToast(text);
}

export function Toaster() {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number>();
  useEffect(() => {
    showToast = (t) => {
      setText(t);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setText(null), 3500);
    };
  }, []);
  return text ? (
    <div class="toast" role="status">
      {text}
    </div>
  ) : null;
}

// ---------------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  back: "M15 5l-7 7 7 7",
  broadcast: "M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.4M16.2 7.8a6 6 0 010 8.4M12 13a1 1 0 100-2 1 1 0 000 2z",
  stop: "M7 7h10v10H7z",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  screen: "M3 5h18v11H3zM8 20h8M12 16v4",
  install: "M12 3v12M7 10l5 5 5-5M5 19h14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  fullscreen: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  person: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0",
  signout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  unlink: "M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  refresh: "M20 12a8 8 0 11-2.3-5.6M20 4v5h-5",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
};

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------- forms

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {(Object.keys(options) as T[]).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} class={value === k ? "selected" : ""} onClick={() => onChange(k)}>
          {options[k]}
        </button>
      ))}
    </div>
  );
}

/** "Show it on": all the board's screens (null), or the ones ticked. */
export function ScreenChooser({
  value,
  onChange,
  screens,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  screens: { id: string; name: string }[];
}) {
  const chosen = value ?? [];
  return (
    <div class="field compact">
      <span>Show it on</span>
      <label class="check">
        <input
          type="checkbox"
          checked={value === null}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked ? null : screens.map((s) => s.id))}
        />
        <span>All screens</span>
      </label>
      {value !== null &&
        screens.map((s) => (
          <label class="check indent" key={s.id}>
            <input
              type="checkbox"
              checked={chosen.includes(s.id)}
              onChange={() => onChange(chosen.includes(s.id) ? chosen.filter((id) => id !== s.id) : [...chosen, s.id])}
            />
            <span>{s.name}</span>
          </label>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------- status, time

export type ScreenStatus = "awake" | "open" | "offline";

export const STATUS_LABEL: Record<ScreenStatus, string> = {
  awake: "Awake",
  open: "Open, may sleep",
  offline: "Offline",
};

export function StatusDot({ status }: { status: ScreenStatus }) {
  return <span class={`dot dot-${status}`} aria-hidden="true" />;
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Re-renders every so often, for "5 min ago". */
export function useTick(ms = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

// -------------------------------------------------------------------- battery

/** A screen's battery: a reading, "none" (no battery), "unavailable" (the browser won't say) or null (not reported). */
export type Battery = { level: number; charging: boolean; at: string | null } | "none" | "unavailable" | null;

export const isLowBattery = (b: Battery) => !!b && typeof b === "object" && b.level <= LOW_BATTERY_PERCENT && !b.charging;

/** The level as a phone shows it: an outline filled to the level, a bolt while charging. */
export function BatteryBadge({ battery, stale = false }: { battery: Battery; stale?: boolean }) {
  if (!battery || typeof battery !== "object") return null;
  const tone = battery.charging ? "charging" : isLowBattery(battery) ? "low" : "ok";
  const label = `Battery ${battery.level}%${battery.charging ? ", charging" : ""}${stale ? ", when last seen" : ""}`;
  return (
    <span class={`battery battery-${tone}${stale ? " stale" : ""}`} title={label} role="img" aria-label={label}>
      <svg viewBox="0 0 26 14" width="22" height="12" aria-hidden="true">
        <rect x="1" y="1" width="21" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" />
        <rect x="23.2" y="4.5" width="2" height="5" rx="1" fill="currentColor" />
        <rect x="3" y="3" width={Math.max(1.5, (17 * battery.level) / 100)} height="8" rx="1.5" fill="currentColor" />
      </svg>
      <span>{battery.level}%</span>
      {battery.charging && (
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

// -------------------------------------------------------------------- install

const isMobile = (p: Platform) => p === "ios" || p === "android";

/** "Install app" — hidden once NoticeBrd is running as an installed app. */
export function InstallButton({ class: className = "button" }: { class?: string }) {
  const { installed, canPrompt } = useInstall();
  const [helpOpen, setHelpOpen] = useState(false);
  const platform = detectPlatform();
  if (installed) return null;
  const label = isMobile(platform) ? "Add to home screen" : "Install app";

  const onClick = async (e: Event) => {
    e.stopPropagation();
    if (!canPrompt) return setHelpOpen(true);
    if (await promptInstall()) toast(isMobile(platform) ? "NoticeBrd is on your home screen" : "NoticeBrd is installed");
  };

  return (
    <>
      <button class={className} onClick={onClick}>
        <Icon name="install" />
        <span>{label}</span>
      </button>
      {helpOpen && <InstallHelp platform={platform} title={label} onClose={() => setHelpOpen(false)} />}
    </>
  );
}

function InstallHelp({ platform, title, onClose }: { platform: Platform; title: string; onClose: () => void }) {
  const steps = INSTALL_STEPS[platform];
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Modal title={title} onClose={onClose}>
        <p class="muted">NoticeBrd opens in its own full-screen window, without the browser's bars — just the board.</p>
        {steps.length > 1 ? (
          <ol class="steps">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        ) : (
          <p>{steps[0]}</p>
        )}
        <div class="modal-actions">
          <button class="button primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </Modal>
    </div>
  );
}

const INSTALL_STEPS: Record<Platform, string[]> = {
  ios: ["Tap the Share button (the square with an arrow pointing up).", "Scroll down and tap “Add to Home Screen”.", "Tap “Add”."],
  android: ["Open your browser's menu (⋮).", "Tap “Add to Home screen” or “Install app”.", "Tap “Install” or “Add”."],
  "mac-safari": ["In the menu bar, choose File → Add to Dock.", "Click “Add”."],
  "firefox-desktop": [
    "Firefox on computers can't install web apps. Open this page in Chrome, Edge or Safari and choose “Install app” there — or just keep this tab open.",
  ],
  other: ["Open your browser's menu.", "Choose “Install NoticeBrd”, “Install app” or “Add to Home screen”."],
};
