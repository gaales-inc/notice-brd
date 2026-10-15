import { api, ApiError } from "./api";
import { describeDevice } from "./device";
import { load, save } from "./storage";
import { onWakeChange, reloadCostsATap, wakeState } from "./wake";

export interface ScreenMessage {
  id: string;
  text: string;
  color: string;
  speed: "slow" | "normal" | "fast";
  size: "small" | "medium" | "large";
  display: "whole" | "horizontal" | "vertical";
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
/** The server pings every 20 s; this long without a word means the stream is dead. */
const SILENCE_MS = 50_000;

/** The last state, so a screen reloaded without a connection carries on showing its message. */
export const cachedState = () => load<ScreenState | null>(CACHE_KEY, null);

export interface ScreenCallbacks {
  onState: (s: ScreenState) => void;
  onConnection: (c: Connection) => void;
  /** A newer build is out, but reloading now would cost this screen its wake lock. */
  onUpdateReady: () => void;
}

/**
 * Keeps a screen in step with the server: its state arrives over an event
 * stream, and a heartbeat every 20 s reports whether the screen is awake (and
 * brings the state back too, in case the stream is blocked somewhere).
 *
 * Phones and tablets freeze a page in the background and thaw it later with
 * its connections dead but not always closed, so everything here assumes the
 * worst on the way back: whenever the page returns to the front, or the stream
 * has been silent too long, it starts over from hello. Returns a function that
 * stops it all.
 */
export function startScreen({ onState, onConnection, onUpdateReady }: ScreenCallbacks): () => void {
  let stopped = false;
  let events: EventSource | null = null;
  let lastHeard = Date.now();
  let retryTimer: number | undefined;
  let pairTimer: number | undefined;
  let failures = 0;
  let helloInFlight = false;
  let current = cachedState();

  const apply = (state: ScreenState) => {
    current = state;
    save(CACHE_KEY, state);
    onState(state);
    checkVersion(state.version, onUpdateReady);
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
    if (stopped || helloInFlight) return;
    helloInFlight = true;
    window.clearTimeout(retryTimer);
    try {
      apply(await api<ScreenState>("POST", "/api/screen/hello", { device: describeDevice() }));
      failures = 0;
      openEvents();
      void heartbeat();
    } catch {
      onConnection("offline");
      retry();
    } finally {
      helloInFlight = false;
    }
  };

  const openEvents = () => {
    events?.close();
    events = null;
    if (typeof EventSource === "undefined") return; // The heartbeat carries the state instead.
    const es = new EventSource("/api/screen/events");
    events = es;
    lastHeard = Date.now();
    const heard = () => {
      lastHeard = Date.now();
    };
    es.addEventListener("state", (e) => {
      heard();
      try {
        apply(JSON.parse((e as MessageEvent).data));
      } catch {
        /* a garbled event; the next heartbeat corrects it */
      }
    });
    es.addEventListener("ping", heard);
    es.onopen = () => {
      heard();
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
      const state = await api<ScreenState>(
        "POST",
        "/api/screen/status",
        { awake: wake.active, visible: document.visibilityState !== "hidden", needsTap: wake.needsTap },
        10_000
      );
      if (state) apply(state);
      if (!events) onConnection("live");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void hello();
      else onConnection("offline");
    }
  };

  /** Back in front, or the stream went quiet: assume nothing survived and start over. */
  const resume = () => {
    if (stopped || document.visibilityState === "hidden") return;
    failures = 0;
    void hello();
  };

  const watchdog = window.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    if (events && Date.now() - lastHeard > SILENCE_MS) resume();
  }, 10_000);

  const beacon = () => {
    // Lets the dashboard show the screen as closed straight away.
    try {
      navigator.sendBeacon?.("/api/screen/status", new Blob([JSON.stringify({ open: false })], { type: "text/plain" }));
    } catch {
      /* best effort */
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") void heartbeat();
    else resume();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) resume();
  };

  if (current) onState(current);
  void hello();
  const beat = window.setInterval(() => void heartbeat(), HEARTBEAT_MS);
  // Report a change in wake state straight away — but only a change.
  let lastWake = "";
  const stopWake = onWakeChange((w) => {
    const key = `${w.active}|${w.needsTap}`;
    if (key === lastWake) return;
    lastWake = key;
    void heartbeat();
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", resume);
  window.addEventListener("pagehide", beacon);

  return () => {
    stopped = true;
    events?.close();
    window.clearInterval(beat);
    window.clearInterval(watchdog);
    window.clearTimeout(retryTimer);
    window.clearTimeout(pairTimer);
    stopWake();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", resume);
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
 * Except where a reload would leave the screen waiting for a tap to stay awake
 * (Safari): there it says an update is ready, and takes it on the next launch.
 */
function checkVersion(serverVersion: string, onUpdateReady: () => void) {
  if (!serverVersion || serverVersion === "dev" || __APP_VERSION__ === "dev" || serverVersion === __APP_VERSION__) return;
  if (reloadCostsATap() && wakeState().active) {
    onUpdateReady();
    return;
  }
  const last = Number(load<number>("nb.reloadedAt", 0));
  if (Date.now() - last < 10 * 60_000) return;
  save("nb.reloadedAt", Date.now());
  window.location.reload();
}
