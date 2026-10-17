import { Display, SIZE_VMIN, SPEED_CHARS_PER_SECOND, VERTICAL_MAX_CROSSING_SECONDS } from "../../shared/style";
import { detectPlatform } from "./device";
import type { ScreenMessage } from "./screenClient";

/**
 * Full screen on iPhone and iPad, without the status bar, as a video.
 *
 * iOS keeps its status bar over every web page, full screen or not, and over
 * apps added to the home screen (WebKit bugs 264220 and 272392). The one thing
 * a page can show with nothing on top is a video in the system's own player.
 * So on iOS the screen draws its message on a canvas — the same sizes, speeds
 * and layouts as the page (Marquee.tsx) — and plays that canvas as a live
 * video, which a tap takes full screen. Drawing goes on behind the player, so
 * a new message shows straight away.
 *
 * The player answers swipes and pinches itself: swiping down leaves full
 * screen, back to the page, where taps reach Refresh and the panel again.
 */

type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  disablePictureInPicture?: boolean;
  disableRemotePlayback?: boolean;
};
type StreamCanvas = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Pixels per CSS pixel. Letters this size look as sharp at 1.5 as at 2, for half the drawing on a screen that runs all day. */
const MAX_SCALE = 1.5;

/** iOS, with what this needs: a canvas that can be a video, and a video that can go full screen. */
export function videoFullscreenAvailable(): boolean {
  if (detectPlatform() !== "ios") return false;
  const canvas = document.createElement("canvas") as StreamCanvas;
  const video = document.createElement("video") as FullscreenVideo;
  return typeof canvas.captureStream === "function" && typeof video.webkitEnterFullscreen === "function";
}

let canvas: StreamCanvas | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let video: FullscreenVideo | null = null;
let stream: MediaStream | null = null;
let message: ScreenMessage | null = null;
let startedAt = 0;
let frame = 0;
let layout: Layout | null = null;
let layoutKey = "";
let lastStill = 0;
/** Between the player's begin and end events; its own flag isn't kept up to date everywhere. */
let fullscreen = false;
const listeners = new Set<() => void>();

interface Layout {
  width: number;
  height: number;
  font: number;
  lines: string[];
  lineHeight: number;
  /** Seconds per pass; 0 holds still. */
  duration: number;
  /** For scrolls: the box's length, which the text enters from. */
  lead: number;
  textLength: number;
}

const notify = () => listeners.forEach((l) => l());

export const inVideoFullscreen = () => fullscreen;

export function onVideoFullscreenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Starts drawing and playing, inline and out of sight, so the first tap can go straight to full screen. */
export function startVideoScreen() {
  if (video) return;
  canvas = document.createElement("canvas") as StreamCanvas;
  ctx = canvas.getContext("2d");
  sizeCanvas();
  draw(performance.now());

  stream = canvas.captureStream!();
  video = makeVideo(stream);
  play();
  document.addEventListener("visibilitychange", onVisible);
}

function makeVideo(source: MediaStream): FullscreenVideo {
  const v = document.createElement("video") as FullscreenVideo;
  v.muted = true;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.setAttribute("x-webkit-airplay", "deny");
  v.disablePictureInPicture = true;
  v.disableRemotePlayback = true;
  // Behind the black page: there, but nothing to see until it's full screen.
  v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;z-index:-1;pointer-events:none";
  v.srcObject = source;
  // Nothing stops the message: the player's pause button, a keyboard's, or iOS
  // pausing it on the way out of full screen — it plays straight on again.
  v.addEventListener("pause", () => {
    if (video === v && document.visibilityState === "visible") play();
  });
  v.addEventListener("webkitbeginfullscreen", () => {
    fullscreen = true;
    notify();
  });
  v.addEventListener("webkitendfullscreen", () => {
    fullscreen = false;
    notify();
    // Safari can leave the player's picture over the page after a swipe out —
    // the message, covering the page's buttons. A fresh element leaves nothing
    // behind, and is playing and ready for the next time.
    window.setTimeout(() => {
      if (video !== v || !stream) return;
      v.remove();
      v.srcObject = null;
      video = makeVideo(stream);
      play();
    }, 300);
  });
  document.body.appendChild(v);
  return v;
}

export function stopVideoScreen() {
  exitVideoFullscreen();
  document.removeEventListener("visibilitychange", onVisible);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  video?.remove();
  if (video) video.srcObject = null;
  video = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  fullscreen = false;
  canvas = null;
  ctx = null;
  layout = null;
  layoutKey = "";
}

function onVisible() {
  if (document.visibilityState === "visible") play();
}

function play() {
  const attempt = video?.play();
  if (attempt && typeof attempt.catch === "function") attempt.catch(() => undefined);
}

/** What to draw: a message, or nothing (black). */
export function showOnVideo(next: ScreenMessage | null) {
  const restart = !next || !message || next.text !== message.text || next.size !== message.size || next.speed !== message.speed || next.display !== message.display;
  message = next;
  // A new message starts from the edge rather than mid-run, as on the page.
  if (restart) startedAt = performance.now();
  layoutKey = "";
  lastStill = 0;
}

/** Takes the video full screen. Only works straight from a tap; false if it isn't ready yet. */
export function enterVideoFullscreen(): boolean {
  const v = video;
  if (!v || inVideoFullscreen()) return false;
  if (v.paused) play();
  if (v.readyState < 1 || v.webkitSupportsFullscreen === false) return false;
  try {
    v.webkitEnterFullscreen!();
    return true;
  } catch {
    return false;
  }
}

export function exitVideoFullscreen() {
  if (!inVideoFullscreen()) return;
  try {
    video?.webkitExitFullscreen?.();
  } catch {
    /* already out */
  }
}

// ------------------------------------------------------------------ drawing

function sizeCanvas(): boolean {
  if (!canvas) return false;
  const scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
  const w = Math.max(1, Math.round(window.innerWidth * scale));
  const h = Math.max(1, Math.round(window.innerHeight * scale));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

const fontAt = (px: number) => `800 ${px}px ${FONT}`;

/** Words into lines no wider than `max`; a word too long for a line is broken only if `breakWords`. Null if it can't fit. */
function wrap(c: CanvasRenderingContext2D, text: string, max: number, breakWords: boolean): string[] | null {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const tryLine = line ? `${line} ${word}` : word;
    if (c.measureText(tryLine).width <= max) {
      line = tryLine;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (c.measureText(word).width > max) {
      if (!breakWords) return null;
      let piece = "";
      for (const ch of [...word]) {
        if (piece && c.measureText(piece + ch).width > max) {
          lines.push(piece);
          piece = "";
        }
        piece += ch;
      }
      line = piece;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function makeLayout(c: CanvasRenderingContext2D, m: ScreenMessage, width: number, height: number): Layout {
  const display = (m.display ?? "horizontal") as Display;
  const size = m.size as "medium";
  const short = Math.min(width, height);
  const chars = Math.max(1, [...m.text].length);
  const cps = SPEED_CHARS_PER_SECOND[m.speed as keyof typeof SPEED_CHARS_PER_SECOND] ?? 4.5;

  if (display === "whole") {
    // As large as fits inside 4% / 5% padding (of the width, as CSS has it), up to the chosen size.
    const availW = width * 0.9;
    const availH = height - width * 0.08;
    const cap = Math.max(10, Math.round((short * SIZE_VMIN.whole[size]) / 100));
    const fit = (px: number, breakWords: boolean) => {
      c.font = fontAt(px);
      const lines = wrap(c, m.text, availW, breakWords);
      return lines && lines.length * px * 1.12 <= availH ? lines : null;
    };
    for (const breakWords of [false, true]) {
      let lo = 6;
      let hi = cap;
      if (!fit(lo, breakWords)) continue;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (fit(mid, breakWords)) lo = mid;
        else hi = mid;
      }
      const px = fit(hi, breakWords) ? hi : lo;
      return { width, height, font: px, lines: fit(px, breakWords)!, lineHeight: px * 1.12, duration: 0, lead: 0, textLength: 0 };
    }
    c.font = fontAt(6);
    return { width, height, font: 6, lines: wrap(c, m.text, availW, true) ?? [m.text], lineHeight: 6 * 1.12, duration: 0, lead: 0, textLength: 0 };
  }

  if (display === "vertical") {
    const font = Math.max(10, Math.round((short * SIZE_VMIN.vertical[size]) / 100));
    c.font = fontAt(font);
    const lines = wrap(c, m.text, width * 0.88, true) ?? [m.text];
    const lineHeight = font * 1.18;
    const textHeight = Math.max(1, lines.length * lineHeight);
    const lead = height;
    const byReading = (cps * textHeight) / chars;
    const byCrossing = lead / VERTICAL_MAX_CROSSING_SECONDS[m.speed as keyof typeof VERTICAL_MAX_CROSSING_SECONDS];
    return { width, height, font, lines, lineHeight, duration: (lead + textHeight) / Math.max(byReading, byCrossing), lead, textLength: textHeight };
  }

  const font = Math.max(10, Math.round((short * SIZE_VMIN.horizontal[size]) / 100));
  c.font = fontAt(font);
  const textWidth = Math.max(1, c.measureText(m.text).width);
  const lead = width;
  return { width, height, font, lines: [m.text], lineHeight: font * 1.15, duration: (lead + textWidth) / ((cps * textWidth) / chars), lead, textLength: textWidth };
}

function draw(now: number) {
  frame = requestAnimationFrame(draw);
  const c = ctx;
  if (!c || !canvas) return;
  const resized = sizeCanvas();
  const width = canvas.width;
  const height = canvas.height;
  const m = message;
  const key = m ? `${width}x${height}|${m.text}|${m.size}|${m.speed}|${m.display}` : "";
  if (m && key !== layoutKey) {
    layout = makeLayout(c, m, width, height);
    layoutKey = key;
  }
  // Nothing moving, or nobody watching (out of full screen the video is out of
  // sight): a frame a second keeps it ready, and spares the battery.
  const still = !m || !layout || layout.duration === 0 || !inVideoFullscreen();
  if (still && !resized && now - lastStill < 1000) return;
  lastStill = now;

  c.fillStyle = "#000";
  c.fillRect(0, 0, width, height);
  if (!m || !layout) return;
  c.font = fontAt(layout.font);
  c.fillStyle = m.color;
  c.textBaseline = "middle";

  if (layout.duration === 0) {
    c.textAlign = "center";
    const top = height / 2 - (layout.lines.length * layout.lineHeight) / 2;
    layout.lines.forEach((line, i) => c.fillText(line, width / 2, top + (i + 0.5) * layout!.lineHeight));
    return;
  }
  const progress = (((now - startedAt) / 1000) % layout.duration) / layout.duration;
  const offset = layout.lead - progress * (layout.lead + layout.textLength);
  if ((m.display ?? "horizontal") === "vertical") {
    c.textAlign = "center";
    layout.lines.forEach((line, i) => {
      const y = offset + (i + 0.5) * layout!.lineHeight;
      if (y > -layout!.lineHeight && y < height + layout!.lineHeight) c.fillText(line, width / 2, y);
    });
  } else {
    c.textAlign = "left";
    c.fillText(m.text, offset, height / 2);
  }
}
