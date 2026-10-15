/**
 * Dashboard sign-in: a six-digit code sent to the board owner's or
 * collaborator's email, exchanged for a session cookie.
 *
 * A code works once, expires in ten minutes and survives
 * five wrong guesses; with the per-address resend cooldown and the per-IP
 * limits in app.ts, a guesser gets nowhere near the million combinations. Only
 * hashes of codes and tokens are stored, so a database dump can't sign anyone in.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { clearCookie, readCookie, SESSION_COOKIE, setCookie } from "./cookies";
import { Db } from "./db";
import { Mailer } from "./mailr";

export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_CODE_ATTEMPTS = 5;
export const SESSION_TTL_DAYS = 180;
const SESSION_COOKIE_PATH = "/api";

export interface User {
  id: string;
  email: string;
}

export interface AuthedRequest extends Request {
  user?: User;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return email;
}

export async function userFromRequest(db: Db, req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await db.query<User>(
    `SELECT u.id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [sha256(token)]
  );
  return rows[0] ?? null;
}

export function requireUser(db: Db) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = await userFromRequest(db, req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    req.user = user;
    next();
  };
}

export function authRouter(db: Db, mailer: Mailer, codeCooldownSeconds: number): Router {
  const router = Router();

  router.post("/code", async (req: Request, res: Response) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }

    // Per address, not per IP: someone rotating addresses can't use this to
    // flood one inbox with codes.
    const { rows: recent } = await db.query(
      "SELECT 1 FROM login_codes WHERE email = $1 AND sent_at > $2::timestamptz",
      [email, new Date(Date.now() - codeCooldownSeconds * 1000).toISOString()]
    );
    if (recent.length) {
      res.status(429).json({ error: "A code was just sent. Wait a moment before asking for another." });
      return;
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await db.query(
      `INSERT INTO login_codes (email, code_hash, attempts, sent_at, expires_at)
       VALUES ($1, $2, 0, NOW(), $3::timestamptz)
       ON CONFLICT (email) DO UPDATE
         SET code_hash = EXCLUDED.code_hash, attempts = 0,
             sent_at = EXCLUDED.sent_at, expires_at = EXCLUDED.expires_at`,
      [email, sha256(`${email}:${code}`), new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString()]
    );

    try {
      await mailer({
        to: email,
        subject: `${code} is your NoticeBrd verification code`,
        brand: "noticebrd",
        preheader: "Your NoticeBrd verification code — good for 10 minutes.",
        footer_note: "You received this because someone asked to open the NoticeBrd dashboard with this address.",
        blocks: [
          { type: "heading", text: "Your NoticeBrd verification code" },
          { type: "text", text: "Enter this code to open your NoticeBrd dashboard:" },
          { type: "code", text: code },
          {
            type: "note",
            text:
              "The code works once and expires in 10 minutes. If you didn't ask " +
              "for it, you can ignore this email — nobody can sign in without it.",
          },
        ],
      });
    } catch (err) {
      console.error("Failed to send verification code:", err);
      res.status(502).json({ error: "Couldn't send the code. Try again shortly." });
      return;
    }

    res.json({ ok: true });
  });

  router.post("/verify", async (req: Request, res: Response) => {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code.replace(/\s+/g, "") : "";
    if (!email || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: "Enter the 6-digit code from the email." });
      return;
    }

    const session = await db.transaction(async (q) => {
      const { rows } = await q.query<{ code_hash: string; attempts: number; live: boolean }>(
        `SELECT code_hash, attempts, expires_at > NOW() AS live
           FROM login_codes WHERE email = $1 FOR UPDATE`,
        [email]
      );
      const row = rows[0];
      if (!row || !row.live || row.attempts >= MAX_CODE_ATTEMPTS) return null;

      const matches = timingSafeEqual(
        Buffer.from(row.code_hash, "hex"),
        Buffer.from(sha256(`${email}:${code}`), "hex")
      );
      if (!matches) {
        await q.query("UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
        return null;
      }

      await q.query("DELETE FROM login_codes WHERE email = $1", [email]);
      // A collaborator invited before they ever signed in already has a row.
      const { rows: users } = await q.query<User>(
        `INSERT INTO users (email, verified_at) VALUES ($1, NOW())
         ON CONFLICT (email) DO UPDATE SET verified_at = COALESCE(users.verified_at, NOW())
         RETURNING id, email`,
        [email]
      );
      const user = users[0]!;

      const token = newToken();
      await q.query("DELETE FROM sessions WHERE user_id = $1 AND expires_at < NOW()", [user.id]);
      await q.query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3::timestamptz)",
        [sha256(token), user.id, new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString()]
      );
      return { token, user };
    });

    if (!session) {
      res.status(401).json({ error: "That code is wrong or has expired." });
      return;
    }
    setCookie(res, SESSION_COOKIE, session.token, { path: SESSION_COOKIE_PATH, maxAgeDays: SESSION_TTL_DAYS });
    res.json({ user: session.user });
  });

  router.post("/logout", async (req: Request, res: Response) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    clearCookie(res, SESSION_COOKIE, SESSION_COOKIE_PATH);
    res.json({ ok: true });
  });

  router.get("/me", async (req: Request, res: Response) => {
    const user = await userFromRequest(db, req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    res.json({ user });
  });

  return router;
}
