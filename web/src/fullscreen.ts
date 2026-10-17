import { detectPlatform, inNativeApp } from "./device";
import { isStandalone } from "./install";

/**
 * Full screen for screen mode, like a video: no browser bars and, where the
 * system allows it, no status bar or navigation bar.
 *
 * A page can only go full screen in answer to a tap or click, so the screen
 * asks on every tap until it is — usually the first one. An app installed on
 * Android already runs full screen (the manifest asks for it), and so does a
 * browser in its own full-screen mode; neither needs asking.
 *
 * iPhone and iPad keep their status bar whatever a web page does (WebKit bugs
 * 264220 and 272392). In Safari, full screen still hides Safari's own bars; an
 * app on the home screen has none to hide, and the black page drawn under the
 * status bar is as far as a web app can go there. The NoticeBrd app for
 * iPhone and iPad (ios/) hides it, and is full screen already.
 */

type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

/** Turned off from the screen's panel; asked for again after a reload. */
let declined = false;

export function canFullscreen(): boolean {
  const doc = document as FullscreenDoc;
  const el = document.documentElement as FullscreenEl;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  return enabled !== false && !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

export const isFullscreen = () => !!(document.fullscreenElement || (document as FullscreenDoc).webkitFullscreenElement);

/** The window is already as full as it gets: an installed full-screen app, a browser in full-screen mode, an iOS home-screen app or the NoticeBrd app. */
export function windowIsFullscreen(): boolean {
  if (inNativeApp() || (detectPlatform() === "ios" && isStandalone())) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(display-mode: fullscreen)").matches;
}

/** Whether a tap would take the screen full screen. */
export const fullscreenOnTap = () => !declined && !isFullscreen() && !windowIsFullscreen() && canFullscreen();

/** Asks for full screen, unless it's on already or was turned off. Call it from a tap. */
export function enterFullscreen(force = false) {
  if (force) declined = false;
  if (!fullscreenOnTap()) return;
  const el = document.documentElement as FullscreenEl;
  try {
    if (el.requestFullscreen) {
      const asked = el.requestFullscreen({ navigationUI: "hide" }) as Promise<void> | undefined;
      asked?.catch?.(() => undefined);
    } else el.webkitRequestFullscreen?.();
  } catch {
    /* refused: the next tap asks again */
  }
}

/** Leaves full screen; `remember` keeps taps from asking again until the page reloads. */
export function exitFullscreen(remember: boolean) {
  if (remember) declined = true;
  if (!isFullscreen()) return;
  const doc = document as FullscreenDoc;
  try {
    if (doc.exitFullscreen) {
      const left = doc.exitFullscreen() as Promise<void> | undefined;
      left?.catch?.(() => undefined);
    } else doc.webkitExitFullscreen?.();
  } catch {
    /* already out */
  }
}

export function onFullscreenChange(listener: () => void): () => void {
  document.addEventListener("fullscreenchange", listener);
  document.addEventListener("webkitfullscreenchange", listener);
  return () => {
    document.removeEventListener("fullscreenchange", listener);
    document.removeEventListener("webkitfullscreenchange", listener);
  };
}
