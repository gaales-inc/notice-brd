/**
 * localStorage, minus the ways it throws: Safari's old private mode, storage
 * turned off, or a full quota. Nothing NoticeBrd keeps here is essential.
 */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not essential */
  }
}

/** What this device was last used as, so the installed app opens straight into it. */
export type Mode = "screen" | "dashboard";
export const getMode = () => load<Mode | null>("nb.mode", null);
export const setMode = (mode: Mode | null) => save("nb.mode", mode);
