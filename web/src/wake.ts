import { detectPlatform, iosVersion } from "./device";
import { isStandalone } from "./install";

/**
 * Keeping the screen on while a board is showing.
 *
 * The Screen Wake Lock API does it in Chrome, Edge, Samsung Internet, Firefox
 * (126+) and Safari (16.4+; in home-screen apps from iOS 18.4). It is released
 * whenever the page is hidden, and sometimes by the system while it isn't, so
 * it is taken again whenever it drops.
 *
 * Safari grants the first lock in a page only from a tap. After that it lets
 * the page take it again by itself — when the app comes back from the home
 * screen, say — until the page is reloaded. So a screen on an iPhone or iPad
 * needs one tap each time the app is opened, and asks for it plainly.
 *
 * Where there is no working wake lock — older Safari and Firefox, and iOS
 * home-screen apps before 18.4, which grant the lock and then ignore it — a
 * tiny silent video plays on a loop instead: a playing video keeps any phone
 * awake. It, too, can only start from a tap.
 */

export interface WakeState {
  /** The screen is being kept on. */
  active: boolean;
  method: "lock" | "video" | null;
  /** Keeping it on needs a tap on the screen first. */
  needsTap: boolean;
  /** Nothing this browser offers can keep it on; the device's own settings must. */
  unsupported: boolean;
}

interface Sentinel extends EventTarget {
  released?: boolean;
  release(): Promise<void>;
}

const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } };
const hasLock = !!nav.wakeLock;

let wanted = false;
let sentinel: Sentinel | null = null;
/** The browser wants a tap before it grants the lock (Safari, once per page). */
let lockNeedsTap = false;
/** The lock failed for another reason: battery saver, a policy, an old engine. */
let lockFailed = false;
let requesting = false;
let video: HTMLVideoElement | null = null;
let videoPlaying = false;
let videoBlocked = false;
/** The browser can't play the video at all. */
let videoFailed = false;
let retryTimer: number | undefined;
/** This browser wanted a tap before keeping the screen on — and will again after a reload. */
let tapNeededOnLoad = false;
/** When the screen was last tapped; a refusal soon after one means a tap doesn't help. */
let lastTapAt = 0;
const listeners = new Set<(s: WakeState) => void>();

/**
 * iOS home-screen apps before 18.4 hand out a wake lock that does nothing.
 * Some home-screen apps don't say which iOS they run on; those get the video
 * too, since a screen that sleeps is worse than one that plays a silent video.
 */
function lockIsHollow(): boolean {
  if (detectPlatform() !== "ios" || !isStandalone()) return false;
  const v = iosVersion();
  return v === null || v < 18.04;
}

function needsVideo(): boolean {
  return !hasLock || lockFailed || lockIsHollow();
}

const visible = () => document.visibilityState !== "hidden";

export function wakeState(): WakeState {
  const video = needsVideo();
  const active = video ? videoPlaying : !!sentinel && !sentinel.released;
  const tapWouldHelp = video ? videoBlocked : lockNeedsTap;
  return {
    active,
    method: active ? (video ? "video" : "lock") : null,
    needsTap: wanted && visible() && !active && tapWouldHelp,
    unsupported: wanted && !active && video && !videoBlocked && videoFailed,
  };
}

function emit() {
  const s = wakeState();
  listeners.forEach((l) => l(s));
}

/** A reload would leave the screen waiting for a tap before it stays awake again. */
export const reloadCostsATap = () => tapNeededOnLoad;

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
    // The lock already holds: no need to keep a video running.
    if (!needsVideo() && sentinel && !sentinel.released) v.pause();
    emit();
  });
  v.addEventListener("pause", () => {
    videoPlaying = false;
    emit();
  });
  v.addEventListener("error", () => {
    videoFailed = true;
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
      videoBlocked = tapNeededOnLoad = true;
      emit();
    });
  }
}

/**
 * Asks for the lock. Called straight from a tap it carries the tap's
 * permission, which is what Safari needs the first time. Refused even then,
 * a tap won't help: the browser just won't, and the video takes over.
 */
function takeLock(fromTap = false) {
  if (!hasLock || requesting || (sentinel && !sentinel.released) || !visible()) return;
  requesting = true;
  nav
    .wakeLock!.request("screen")
    .then((s) => {
      sentinel = s;
      lockNeedsTap = false;
      lockFailed = false;
      if (video && videoPlaying && !needsVideo()) video.pause();
      s.addEventListener("release", () => {
        if (sentinel === s) sentinel = null;
        emit();
        // Released while still showing (the system can do that): take it back.
        if (wanted && visible()) scheduleRetry(1_000);
      });
    })
    .catch((err: { name?: string }) => {
      const afterTap = fromTap || Date.now() - lastTapAt < 3_000;
      if (err && err.name === "NotAllowedError" && !afterTap) lockNeedsTap = tapNeededOnLoad = true;
      else {
        lockNeedsTap = false;
        lockFailed = true;
      }
    })
    .then(() => {
      requesting = false;
      if (needsVideo() && !videoPlaying) startVideo();
      emit();
    });
}

function scheduleRetry(ms: number) {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(acquire, ms);
}

function acquire() {
  if (!wanted || !visible()) return emit();
  takeLock();
  if (needsVideo() && !videoPlaying && !videoBlocked) startVideo();
  emit();
}

export function keepAwake() {
  if (wanted) return;
  wanted = true;
  acquire();
}

export function letSleep() {
  wanted = false;
  window.clearTimeout(retryTimer);
  void sentinel?.release().catch(() => undefined);
  sentinel = null;
  video?.pause();
  emit();
}

/** Call from every tap on the screen: Safari only grants the lock, and any browser a video, after one. */
export function nudge() {
  if (!wanted) return;
  lastTapAt = Date.now();
  // The video can only start here, inside the tap. Start it whenever the lock
  // isn't holding yet: if the lock then comes through, the video stops again.
  if (!wakeState().active && (needsVideo() || lockNeedsTap) && !videoPlaying) startVideo();
  takeLock(true);
}

document.addEventListener("visibilitychange", () => {
  if (visible()) acquire();
  else emit();
});
window.addEventListener("pageshow", () => acquire());
window.addEventListener("focus", () => acquire());
// A lock can lapse without an event on some engines; check now and then.
window.setInterval(() => {
  if (wanted && visible() && !wakeState().active) acquire();
}, 30_000);
