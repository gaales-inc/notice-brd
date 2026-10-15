import { api, ApiError } from "./api";
import { describeDevice } from "./device";
import { load, save } from "./storage";
import { onWakeChange, wakeState } from "./wake";

export interface ScreenMessage {
  id: string;
  text: string;
  color: string;
  speed: "slow" | "normal" | "fast";
  size: "small" | "medium" | "large";
}

export interface ScreenState {
  version: string;
  screen: { id: string; name: string };
  paired: boolean;
  pairCode: string | null;
  pairExpiresAt: string | null;
  board: { name: string } | null;
  message: ScreenMessage | null;
}

export type Connection = "connecting" | "live" | "offline";

const CACHE_KEY = "nb.screen";
const HEARTBEAT_MS = 20_000;

/** The last state, so a screen reloaded without a connection carries on showing its message. */
export const cachedState = () => load<ScreenState | null>(CACHE_KEY, null);

/**
 * Keeps a screen in step with the server: its state arrives over an event
 * stream, and a heartbeat every 20 s reports whether the screen is awake (and
 * brings the state back too, in case the stream is blocked somewhere). Returns
 * a function that stops it all.
 */
export function startScreen(onState: (s: ScreenState) => void, onConnection: (c: Connection) => void): () => void {
  let stopped = false;
  let events: EventSource | null = null;
  let retryTimer: number | undefined;
  let pairTimer: number | undefined;
  let failures = 0;
  let current = cachedState();

  const apply = (state: ScreenState) => {
    current = state;
    save(CACHE_KEY, state);
    onState(state);
    maybeUpdate(state.version);
    // An unpaired screen fetches a new code shortly before its old one runs out.
    window.clearTimeout(pairTimer);
    if (!state.paired && state.pairExpiresAt) {
      const wait = Math.max(5_000, new Date(state.pairExpiresAt).getTime() - Date.now() - 30_000);
      pairTimer = window.setTimeout(() => void hello(), Math.min(wait, 30 * 60_000));
    }
  };

  const retry = () => {
    if (stopped) return;
    window.clearTimeout(retryTimer);
    failures++;
    const wait = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
    retryTimer = window.setTimeout(() => void hello(), wait);
  };

  const hello = async () => {
    if (stopped) return;
    try {
      apply(await api<ScreenState>("POST", "/api/screen/hello", { device: describeDevice() }));
      failures = 0;
      openEvents();
      void heartbeat();
    } catch {
      onConnection("offline");
      retry();
    }
  };

  const openEvents = () => {
    events?.close();
    if (typeof EventSource === "undefined") return; // The heartbeat carries the state instead.
    const es = new EventSource("/api/screen/events");
    events = es;
    es.addEventListener("state", (e) => {
      try {
        apply(JSON.parse((e as MessageEvent).data));
      } catch {
        /* a garbled event; the next heartbeat corrects it */
      }
    });
    es.onopen = () => {
      failures = 0;
      onConnection("live");
    };
    es.onerror = () => {
      onConnection(es.readyState === EventSource.OPEN ? "live" : "offline");
      // CONNECTING retries on its own; CLOSED (an error status — the server
      // restarting, say) is ours to retry, through hello in case the screen is new.
      if (es.readyState === EventSource.CLOSED && events === es) {
        events = null;
        retry();
      }
    };
  };

  const heartbeat = async () => {
    if (stopped) return;
    const wake = wakeState();
    try {
      const state = await api<ScreenState>("POST", "/api/screen/status", {
        awake: wake.active,
        visible: document.visibilityState !== "hidden",
      });
      if (state) apply(state);
      if (!events || events.readyState === EventSource.CLOSED) onConnection("live");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void hello();
      else onConnection("offline");
    }
  };

  const beacon = () => {
    // Lets the dashboard show the screen as closed straight away.
    try {
      navigator.sendBeacon?.("/api/screen/status", new Blob([JSON.stringify({ open: false })], { type: "text/plain" }));
    } catch {
      /* best effort */
    }
  };

  const onVisibility = () => void heartbeat();
  const onOnline = () => {
    failures = 0;
    if (!events || events.readyState === EventSource.CLOSED) void hello();
  };

  if (current) onState(current);
  void hello();
  const beat = window.setInterval(() => void heartbeat(), HEARTBEAT_MS);
  const stopWake = onWakeChange(() => void heartbeat());
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", beacon);

  return () => {
    stopped = true;
    events?.close();
    window.clearInterval(beat);
    window.clearTimeout(retryTimer);
    window.clearTimeout(pairTimer);
    stopWake();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pagehide", beacon);
    beacon();
  };
}

export async function unpairScreen(): Promise<ScreenState> {
  return api<ScreenState>("POST", "/api/screen/unpair");
}

/**
 * A screen can run for weeks. When the server is on a newer build, reload to
 * pick it up — at most once every ten minutes, so a bad deploy can't loop it.
 */
function maybeUpdate(serverVersion: string) {
  if (!serverVersion || serverVersion === "dev" || __APP_VERSION__ === "dev" || serverVersion === __APP_VERSION__) return;
  const last = Number(load<number>("nb.reloadedAt", 0));
  if (Date.now() - last < 10 * 60_000) return;
  save("nb.reloadedAt", Date.now());
  window.location.reload();
}
