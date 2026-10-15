import { iosVersion } from "./device";
import { isStandalone } from "./install";

/**
 * Keeping the screen on while a board is showing.
 *
 * The Screen Wake Lock API does it in Chrome, Edge, Samsung Internet, Firefox
 * (126+) and Safari (16.4+). It is released whenever the page is hidden, so it
 * is taken again each time the page comes back.
 *
 * Where there is no wake lock — older Safari, older Firefox, and iOS home-screen
 * apps before 18.4, which grant the lock and then ignore it — a tiny silent
 * video plays on a loop instead: a playing video keeps any phone awake. A video
 * with sound may only start from a tap, so on those browsers the screen asks
 * for one.
 */

export interface WakeState {
  /** The screen is being kept on. */
  active: boolean;
  method: "lock" | "video" | null;
  /** Keeping it on needs a tap on the screen first. */
  needsTap: boolean;
}

interface Sentinel extends EventTarget {
  release(): Promise<void>;
}

const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } };
const hasLock = !!nav.wakeLock;

let wanted = false;
let sentinel: Sentinel | null = null;
let lockFailed = false;
let video: HTMLVideoElement | null = null;
let videoPlaying = false;
let videoBlocked = false;
const listeners = new Set<(s: WakeState) => void>();

/** iOS home-screen apps before 18.4 hand out a wake lock that does nothing. */
function lockIsHollow(): boolean {
  const v = iosVersion();
  return v !== null && v < 18.04 && isStandalone();
}

function needsVideo(): boolean {
  return !hasLock || lockFailed || lockIsHollow();
}

export function wakeState(): WakeState {
  const video = needsVideo();
  const active = video ? videoPlaying : !!sentinel;
  return {
    active,
    method: active ? (video ? "video" : "lock") : null,
    needsTap: wanted && !active && video && videoBlocked && document.visibilityState === "visible",
  };
}

function emit() {
  const s = wakeState();
  listeners.forEach((l) => l(s));
}

export function onWakeChange(listener: (s: WakeState) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function getVideo(): HTMLVideoElement {
  if (video) return video;
  const v = document.createElement("video");
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.setAttribute("title", "NoticeBrd");
  v.loop = true;
  v.preload = "auto";
  for (const [src, type] of [
    ["/awake.webm", "video/webm"],
    ["/awake.mp4", "video/mp4"],
  ]) {
    const source = document.createElement("source");
    source.src = src;
    source.type = type;
    v.appendChild(source);
  }
  // iOS 15+ only counts a video that is in the document.
  v.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0;pointer-events:none";
  v.addEventListener("playing", () => {
    videoPlaying = true;
    videoBlocked = false;
    emit();
  });
  v.addEventListener("pause", () => {
    videoPlaying = false;
    emit();
  });
  document.body.appendChild(v);
  return (video = v);
}

/** Where a video with sound may only start from a tap, this must run straight from the tap handler. */
function startVideo() {
  const v = getVideo();
  let attempt: Promise<void> | undefined;
  try {
    attempt = v.play();
  } catch {
    videoBlocked = true;
  }
  if (attempt && typeof attempt.catch === "function") {
    attempt.catch(() => {
      videoBlocked = true;
      emit();
    });
  }
}

async function takeLock() {
  if (!hasLock || sentinel || document.visibilityState !== "visible") return;
  try {
    const s = await nav.wakeLock!.request("screen");
    sentinel = s;
    lockFailed = false;
    s.addEventListener("release", () => {
      if (sentinel === s) sentinel = null;
      emit();
    });
  } catch {
    // Battery saver, a permissions policy, or a browser wanting a tap first.
    lockFailed = true;
  }
}

async function acquire() {
  if (!wanted || document.visibilityState !== "visible") return emit();
  await takeLock();
  if (needsVideo()) {
    if (!videoPlaying) startVideo();
  } else if (videoPlaying) {
    // The lock came through after all; the video can stop.
    video?.pause();
  }
  emit();
}

export function keepAwake() {
  if (wanted) return;
  wanted = true;
  void acquire();
}

export function letSleep() {
  wanted = false;
  void sentinel?.release().catch(() => undefined);
  sentinel = null;
  video?.pause();
  emit();
}

/** Call from every tap on the screen: some browsers only grant either way after one. */
export function nudge() {
  if (!wanted) return;
  if (needsVideo() && !videoPlaying) startVideo();
  if (!sentinel) void acquire();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void acquire();
  else emit();
});
