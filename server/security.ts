/**
 * Perimeter middleware, ported from gula-api and kept dependency-free for the
 * same reason: this ships a two-stage Docker build on a 3.7 GB box.
 */
import { NextFunction, Request, Response } from "express";

/**
 * Cloudflare terminates TLS and cloudflared forwards, so the socket address is
 * always the tunnel. CF-Connecting-IP is the only client address worth keying
 * on, and it cannot be spoofed from outside — Cloudflare overwrites it.
 */
export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();

  return req.socket?.remoteAddress || "unknown";
}

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "media-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", CSP);
  next();
}

/**
 * Sessions are cookies (EventSource can't send an Authorization header), so a
 * write must come from this site. SameSite=Lax already keeps the cookie off
 * cross-site POSTs; this refuses any that a browser marks as foreign anyway.
 */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* "null" and other junk: refused below */
    }
    // cloudflared keeps the public Host; X-Forwarded-Host covers a proxy that doesn't.
    const forwarded = req.headers["x-forwarded-host"];
    if (host !== req.headers.host && host !== (Array.isArray(forwarded) ? forwarded[0] : forwarded)) {
      res.status(403).json({ error: "Cross-site request refused" });
      return;
    }
  }
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit({
  windowMs,
  max,
  message = "Too many requests. Wait a little and try again.",
}: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();

  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = clientIp(req);
    const entry = buckets.get(key);

    if (!entry || now > entry.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
      }
      next();
      return;
    }

    entry.count += 1;
    if (entry.count <= max) {
      next();
      return;
    }

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: message });
  };
}
