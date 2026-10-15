export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * JSON over fetch, same origin, with the session cookie. Throws ApiError on a
 * non-2xx answer. Gives up after `timeoutMs`: a phone or tablet woken from
 * sleep can hold a request open on a dead connection for minutes, and a
 * screen waiting on it would wait with it.
 */
export async function api<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  const timer = abort ? window.setTimeout(() => abort.abort(), timeoutMs) : undefined;
  try {
    res = await fetch(path, {
      method,
      // Old Safari defaults to "omit".
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort?.signal,
    });
  } catch {
    throw new ApiError(0, "Can't reach NoticeBrd. Check the connection and try again.");
  } finally {
    window.clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* an HTML error page from the proxy, say */
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || (res.status >= 500 ? "NoticeBrd is having trouble. Try again shortly." : "Something went wrong."));
  }
  return data as T;
}
