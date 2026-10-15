import { useEffect, useState } from "preact/hooks";

/** The few routes NoticeBrd has, on the History API. */
const listeners = new Set<() => void>();

export function navigate(path: string, { replace = false } = {}) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const l = () => setPath(location.pathname);
    listeners.add(l);
    // Children's effects run before their parent's, so a child that navigated
    // on mount did so before this listener existed. Catch up with it here —
    // missing it left the installed app blank whenever it opened on "/".
    l();
    return () => void listeners.delete(l);
  }, []);
  return path;
}

/**
 * Where "/" should go on this device: straight back to what it was last used
 * as. Decided before the first render, so the installed app — which always
 * opens on "/" — never renders a page only to leave it.
 */
export function resolveStart(mode: string | null) {
  if (location.pathname !== "/") return;
  if (mode === "screen") history.replaceState(null, "", "/screen");
  else if (mode === "dashboard") history.replaceState(null, "", "/dashboard");
}

/** For <a href> clicks: plain clicks route in the page, modified ones open as usual. */
export function linkHandler(path: string) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  };
}
