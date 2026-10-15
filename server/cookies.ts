import { Request, Response } from "express";

export const SESSION_COOKIE = "nb_session";
export const SCREEN_COOKIE = "nb_screen";

export function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

/**
 * HttpOnly, so page script never sees a token; Secure in production, where
 * Cloudflare serves HTTPS (local development is plain http://localhost).
 */
export function setCookie(res: Response, name: string, value: string, { path, maxAgeDays }: { path: string; maxAgeDays: number }) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path,
    maxAge: maxAgeDays * 86_400_000,
  });
}

export function clearCookie(res: Response, name: string, path: string) {
  res.clearCookie(name, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path });
}
