import { useEffect, useRef, useState } from "preact/hooks";
import { navigate } from "../router";
import { Connection, ScreenState, cachedState, startScreen, unpairScreen } from "../screenClient";
import { setMode } from "../storage";
import { keepAwake, letSleep, nudge, onWakeChange, WakeState, wakeState } from "../wake";
import { Icon, InstallButton, Logo } from "./common";
import { Marquee } from "./Marquee";

type FullscreenDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

const canFullscreen = () => {
  const el = document.documentElement as FullscreenEl;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
};
const isFullscreen = () => !!(document.fullscreenElement || (document as FullscreenDoc).webkitFullscreenElement);

function toggleFullscreen() {
  const doc = document as FullscreenDoc;
  if (isFullscreen()) {
    if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
    else doc.webkitExitFullscreen?.();
    return;
  }
  const el = document.documentElement as FullscreenEl;
  if (el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
  else el.webkitRequestFullscreen?.();
}

function useWake(): WakeState {
  const [state, setState] = useState(wakeState);
  useEffect(() => onWakeChange(setState), []);
  return state;
}

/**
 * The board on a screen. Black, always: either a message running across it,
 * or nothing at all — no clock, no logo — so an OLED panel lights no pixels.
 * Either way the screen is kept awake. A tap shows what it is and how it is
 * doing for a few seconds, then it goes back to black.
 */
export function ScreenPage() {
  const [state, setState] = useState<ScreenState | null>(cachedState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [panel, setPanel] = useState(false);
  const [slow, setSlow] = useState(false);
  const hideTimer = useRef<number>();
  const wake = useWake();

  useEffect(() => {
    setMode("screen");
    document.documentElement.classList.add("on-screen");
    keepAwake();
    const stop = startScreen(setState, setConnection);
    const slowTimer = window.setTimeout(() => setSlow(true), 4000);
    return () => {
      stop();
      letSleep();
      window.clearTimeout(slowTimer);
      document.documentElement.classList.remove("on-screen");
    };
  }, []);

  useEffect(() => {
    document.title = state?.board ? `${state.board.name} · NoticeBrd` : "NoticeBrd screen";
  }, [state?.board?.name]);

  const showPanel = () => {
    setPanel(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPanel(false), 8000);
  };

  const onTap = () => {
    nudge();
    if (panel) {
      setPanel(false);
      window.clearTimeout(hideTimer.current);
    } else showPanel();
  };

  const message = state?.paired ? state.message : null;

  return (
    <div class={`screen${panel ? " with-panel" : ""}`} onClick={onTap}>
      {message && <Marquee message={message} class="marquee-full" />}
      {state && !state.paired && <Pairing state={state} />}
      {!state && slow && <p class="screen-note">{connection === "offline" ? "Can't reach NoticeBrd. Retrying…" : "Connecting…"}</p>}
      {wake.needsTap && !panel && <p class="screen-note screen-tap">Tap the screen to keep it awake</p>}
      {panel && (
        <ScreenPanel
          state={state}
          connection={connection}
          wake={wake}
          onKeep={showPanel}
          onUnpaired={(s) => {
            setState(s);
            setPanel(false);
          }}
        />
      )}
    </div>
  );
}

function Pairing({ state }: { state: ScreenState }) {
  const code = state.pairCode ?? "";
  return (
    <div class="pairing">
      <Logo />
      <h1>Show a board on this screen</h1>
      <div class="pair-code" aria-label={`Pair code ${code.split("").join(" ")}`}>
        <span>{code.slice(0, 3)}</span>
        <span>{code.slice(3)}</span>
      </div>
      <ol>
        <li>
          On your phone or computer, open <b>{location.host}/dashboard</b>
        </li>
        <li>
          Open a board and choose <b>Add screen</b>
        </li>
        <li>Enter the code above</li>
      </ol>
      <p class="faint">The code changes every 30 minutes. Tap the screen for options.</p>
    </div>
  );
}

function ScreenPanel({
  state,
  connection,
  wake,
  onKeep,
  onUnpaired,
}: {
  state: ScreenState | null;
  connection: Connection;
  wake: WakeState;
  onKeep: () => void;
  onUnpaired: (s: ScreenState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [, rerender] = useState(0);

  const unpair = async () => {
    if (!window.confirm("Take this screen off the board? It will show a new pair code.")) return;
    setBusy(true);
    try {
      onUnpaired(await unpairScreen());
    } catch {
      window.alert("Couldn't reach NoticeBrd. Try again.");
    } finally {
      setBusy(false);
    }
  };

  let wakeText = "Keeping the screen awake";
  if (!wake.active) {
    wakeText = wake.needsTap
      ? "Tap the screen to keep it awake"
      : "This browser can't keep the screen awake — turn off auto-lock in the device's settings";
  }

  return (
    <div
      class="screen-panel"
      onClick={(e) => {
        e.stopPropagation();
        onKeep();
      }}
    >
      <div class="screen-panel-head">
        <Logo />
        <span class={`pill ${connection === "live" ? "pill-ok" : "pill-warn"}`}>
          {connection === "live" ? "Connected" : connection === "offline" ? "Offline — retrying" : "Connecting…"}
        </span>
      </div>
      <dl class="facts">
        <dt>Board</dt>
        <dd>{state?.paired ? state.board?.name : "Not paired yet"}</dd>
        {state?.paired && (
          <>
            <dt>Screen</dt>
            <dd>{state.screen.name}</dd>
            <dt>Showing</dt>
            <dd>{state.message ? `“${state.message.text}”` : "Nothing — the screen stays black"}</dd>
          </>
        )}
        <dt>Awake</dt>
        <dd class={wake.active ? "ok" : "warn"}>{wakeText}</dd>
      </dl>
      <div class="screen-panel-actions">
        {canFullscreen() && (
          <button
            class="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
              window.setTimeout(() => rerender((n) => n + 1), 300);
            }}
          >
            <Icon name="fullscreen" />
            <span>{isFullscreen() ? "Exit full screen" : "Full screen"}</span>
          </button>
        )}
        <InstallButton />
        <button
          class="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate("/dashboard");
          }}
        >
          <Icon name="dashboard" />
          <span>Dashboard</span>
        </button>
        {state?.paired && (
          <button class="button danger" disabled={busy} onClick={unpair}>
            <Icon name="unlink" />
            <span>Unpair</span>
          </button>
        )}
      </div>
    </div>
  );
}
