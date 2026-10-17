import { useEffect, useState } from "preact/hooks";
import { inNativeApp } from "./device";

/**
 * Installing NoticeBrd as an app.
 *
 * Chromium browsers (Chrome, Edge, Samsung Internet, Opera) fire
 * `beforeinstallprompt`; holding on to it lets the Install button open the
 * browser's own install dialog. Safari and Firefox have no such API, so the
 * button explains the steps for that browser instead.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = isStandalone();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function isStandalone(): boolean {
  return (
    inNativeApp() ||
    (typeof window.matchMedia === "function" &&
      (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches)) ||
    // iOS Safari's own flag for a page opened from the home screen.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Registered on import, before the app renders: the event can fire early.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  notify();
});

window.addEventListener("appinstalled", () => {
  installed = true;
  deferred = null;
  notify();
});

export function useInstall() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { installed, canPrompt: deferred !== null };
}

/** Opens the browser's install dialog. Resolves true if the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  // Each event can prompt once.
  deferred = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === "accepted";
}
