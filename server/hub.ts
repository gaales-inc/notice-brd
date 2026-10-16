/**
 * Live state: who is listening, and which screens are open and awake.
 *
 * Everything here is in memory, in the one container that serves NoticeBrd.
 * Screens and dashboards hold a Server-Sent Events stream each; a change to a
 * board tells its dashboards to reload and pushes each of its screens its new
 * state. After a restart the streams reconnect on their own and presence
 * rebuilds from the next round of heartbeats.
 *
 * Presence is heartbeat-driven. A screen posts its status every 20 s and on
 * every change (wake lock taken or lost, tab hidden or shown), and a beacon as
 * the page closes. An open stream is not proof of life — a phone that drops off
 * the network leaves its socket half-open for minutes — so a screen counts as
 * open only while its heartbeats are fresh.
 */
import { Response } from "express";

export type ScreenStatus = "awake" | "open" | "offline";

/** Two missed heartbeats, plus slack for a slow network. */
export const ONLINE_WINDOW_MS = 45_000;

interface Presence {
  boardId: string | null;
  /** Epoch ms of the last heartbeat; 0 once the page has said it is closing. */
  lastSeen: number;
  /** Holding a screen wake lock (or the video fallback). */
  awake: boolean;
  /** The page is in the foreground; a hidden page can't keep the screen on. */
  visible: boolean;
  /** The browser will only keep the screen on after someone taps it (Safari, each launch). */
  needsTap: boolean;
  /** The last battery reading, as a key: dashboards hear when it changes. */
  battery: string;
  /** What dashboards were last told, so they hear about changes only. */
  reported: string;
}

export interface StatusReport {
  awake: boolean;
  visible: boolean;
  needsTap?: boolean;
  /** A key for the battery reading; omitted leaves the last one standing. */
  battery?: string;
}

type ScreenListener = (event: string, data: unknown) => void;

export class Hub {
  private boardListeners = new Map<string, Set<() => void>>();
  private screenListeners = new Map<string, Set<ScreenListener>>();
  private presence = new Map<string, Presence>();
  private pendingBoards = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private now: () => number = Date.now) {}

  /** Notices screens whose heartbeats stopped. */
  start(intervalMs = 5_000) {
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  // ---------------------------------------------------------------- dashboards

  subscribeBoard(boardId: string, listener: () => void): () => void {
    let set = this.boardListeners.get(boardId);
    if (!set) this.boardListeners.set(boardId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.boardListeners.delete(boardId);
    };
  }

  /**
   * Tells the board's dashboards to reload. Batched over a few milliseconds,
   * since broadcasting to ten screens is ten changes and one reload.
   */
  notifyBoard(boardId: string | null) {
    if (!boardId) return;
    this.pendingBoards.add(boardId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const boards = [...this.pendingBoards];
      this.pendingBoards.clear();
      for (const id of boards) for (const listener of this.boardListeners.get(id) ?? []) listener();
    }, 50);
  }

  // ------------------------------------------------------------------- screens

  subscribeScreen(screenId: string, listener: ScreenListener): () => void {
    let set = this.screenListeners.get(screenId);
    if (!set) this.screenListeners.set(screenId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.screenListeners.delete(screenId);
    };
  }

  isListening(screenId: string): boolean {
    return this.screenListeners.has(screenId);
  }

  sendScreen(screenId: string, event: string, data: unknown) {
    for (const listener of this.screenListeners.get(screenId) ?? []) listener(event, data);
  }

  /** A heartbeat (or a stream opening, which carries no report). */
  seen(screenId: string, boardId: string | null, report?: StatusReport) {
    const p = this.presence.get(screenId) ?? {
      boardId,
      lastSeen: 0,
      awake: false,
      visible: true,
      needsTap: false,
      battery: "",
      reported: "offline",
    };
    p.boardId = boardId;
    p.lastSeen = this.now();
    if (report) {
      p.awake = report.awake;
      p.visible = report.visible;
      p.needsTap = report.needsTap === true;
      if (report.battery !== undefined) p.battery = report.battery;
    }
    this.presence.set(screenId, p);
    this.check(screenId, p);
  }

  /** The page is closing (its pagehide beacon). */
  closed(screenId: string) {
    const p = this.presence.get(screenId);
    if (!p) return;
    p.lastSeen = 0;
    p.awake = false;
    this.check(screenId, p);
  }

  /** The screen moved to another board, or to none. */
  moved(screenId: string, fromBoardId: string | null, toBoardId: string | null) {
    const p = this.presence.get(screenId);
    if (p) p.boardId = toBoardId;
    this.notifyBoard(fromBoardId);
    this.notifyBoard(toBoardId);
  }

  status(screenId: string): ScreenStatus {
    const p = this.presence.get(screenId);
    return p ? this.compute(p) : "offline";
  }

  /** Open but asleep-able only because nobody has tapped it yet. */
  needsTap(screenId: string): boolean {
    const p = this.presence.get(screenId);
    return !!p && p.needsTap && this.compute(p) === "open";
  }

  /** Epoch ms of the last heartbeat this process saw, if any. */
  lastSeen(screenId: string): number | null {
    const p = this.presence.get(screenId);
    return p && p.lastSeen > 0 ? p.lastSeen : null;
  }

  sweep() {
    const cutoff = this.now() - 60 * 60_000;
    for (const [id, p] of this.presence) {
      this.check(id, p);
      // Long gone and nobody listening: the database has its last_seen_at.
      if (p.reported.startsWith("offline") && p.lastSeen < cutoff && !this.isListening(id)) this.presence.delete(id);
    }
  }

  private compute(p: Presence): ScreenStatus {
    if (!p.lastSeen || this.now() - p.lastSeen > ONLINE_WINDOW_MS) return "offline";
    return p.awake && p.visible ? "awake" : "open";
  }

  private check(_screenId: string, p: Presence) {
    const status = this.compute(p);
    const reported = `${status === "open" && p.needsTap ? "open:tap" : status}|${p.battery}`;
    if (reported === p.reported) return;
    p.reported = reported;
    this.notifyBoard(p.boardId);
  }
}

/**
 * Starts a Server-Sent Events response. Cloudflare drops a response that sends
 * nothing for 100 s, so a `ping` goes out every 20 s; `no-transform` keeps
 * anything on the way from buffering or compressing the stream. The ping is an
 * event rather than a comment because page script never sees comments, and
 * the page needs it: a stream on a tablet woken from sleep can be dead while
 * still reporting itself open, and silence is the only sign.
 */
export function openStream(res: Response, onClose: () => void) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const ping = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 20_000);
  res.on("close", () => {
    clearInterval(ping);
    onClose();
  });

  return (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}
