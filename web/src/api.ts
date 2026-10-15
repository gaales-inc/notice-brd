export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** JSON over fetch, same origin, with the session cookie. Throws ApiError on a non-2xx answer. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // Old Safari defaults to "omit".
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach NoticeBrd. Check the connection and try again.");
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
