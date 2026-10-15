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
    return () => void listeners.delete(l);
  }, []);
  return path;
}

/** For <a href> clicks: plain clicks route in the page, modified ones open as usual. */
export function linkHandler(path: string) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  };
}
