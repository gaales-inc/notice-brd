import express, { NextFunction, Request, Response } from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { authRouter } from "./auth";
import { boardsRouter } from "./boards";
import { CalendarSync, FeedFetcher, fetchFeed } from "./calendar";
import { Db } from "./db";
import { Hub } from "./hub";
import { Mailer } from "./mailr";
import { Live, screenRouter } from "./screens";
import { rateLimit, sameOrigin, securityHeaders } from "./security";

export interface AppOptions {
  db: Db;
  mailer: Mailer;
  hub?: Hub;
  /** The built web app (index.html and its assets). Omitted in tests and in development, where Vite serves it. */
  webDir?: string;
  appUrl?: string;
  /** Off in tests, which sign in more often than any person would. */
  rateLimits?: boolean;
  codeCooldownSeconds?: number;
  /** How calendar feeds are fetched (tests serve their own). */
  fetchCalendar?: FeedFetcher;
  /** The clock meetings are judged by (tests move it). */
  now?: () => number;
}

/** The build id written next to index.html; screens on an older build reload. */
function readVersion(webDir?: string): string {
  if (!webDir) return "dev";
  try {
    return readFileSync(path.join(webDir, "version.txt"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

export function createApp({
  db,
  mailer,
  hub = new Hub(),
  webDir,
  appUrl = "https://noticebrd.gaales.com",
  rateLimits = true,
  codeCooldownSeconds = 30,
  fetchCalendar = fetchFeed,
  now = Date.now,
}: AppOptions) {
  const app = express();
  webDir = webDir && path.resolve(webDir);
  const live = new Live(db, hub, readVersion(webDir));
  live.now = now;
  const calendar = new CalendarSync(live, fetchCalendar, now);
  live.evaluateCalendar = (boardId) => calendar.evaluate(boardId);
  app.disable("x-powered-by");
  app.use(securityHeaders);

  app.get("/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok", version: live.version });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });

  if (rateLimits) {
    // Screens heartbeat three times a minute, and a venue's screens can share one address.
    app.use("/api", rateLimit({ windowMs: 5 * 60 * 1000, max: 1500 }));
    // Each request here spends a mail send, so this is the tightest budget.
    app.use("/api/auth/code", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));
    app.use("/api/auth/verify", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
    app.use("/api/screen/hello", rateLimit({ windowMs: 15 * 60 * 1000, max: 120 }));
    // Pair codes are guessable in principle; this keeps it to principle.
    app.use(/^\/api\/boards\/[^/]+\/screens$/, rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
    app.use(/^\/api\/boards\/[^/]+\/members$/, rateLimit({ windowMs: 60 * 60 * 1000, max: 30 }));
    // Adding or refreshing a calendar makes the server fetch someone else's URL.
    app.use(/^\/api\/boards\/[^/]+\/calendars(\/[^/]+\/refresh)?$/, rateLimit({ windowMs: 60 * 60 * 1000, max: 60 }));
  }

  app.use("/api", sameOrigin);
  // The pagehide beacon can only send text/plain without a CORS preflight on
  // some browsers, so the screen's status endpoint takes JSON in either type.
  app.use("/api/screen/status", express.json({ limit: "4kb", type: ["application/json", "text/plain"] }));
  app.use(express.json({ limit: "32kb" }));

  app.use("/api/auth", authRouter(db, mailer, codeCooldownSeconds));
  app.use("/api/screen", screenRouter(live));
  app.use("/api", boardsRouter(live, mailer, appUrl.replace(/\/+$/, ""), calendar));
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  if (webDir && existsSync(path.join(webDir, "index.html"))) {
    const index = path.join(webDir, "index.html");
    app.use(
      express.static(webDir, {
        index: false,
        setHeaders(res, file) {
          const name = path.basename(file);
          if (file.includes(`${path.sep}assets${path.sep}`)) {
            // Hashed file names never change content.
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else if (name === "sw.js" || name === "manifest.webmanifest" || name === "version.txt") {
            // Checked on every load, so a deploy takes effect straight away.
            res.setHeader("Cache-Control", "no-cache");
          } else {
            res.setHeader("Cache-Control", "public, max-age=86400");
          }
          if (name === "manifest.webmanifest") res.setHeader("Content-Type", "application/manifest+json");
        },
      })
    );
    // Client-side routes (/screen, /dashboard/…) all serve the app.
    app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(index);
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large" });
      return;
    }
    if (err.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON" });
      return;
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong" });
  });

  return { app, live, calendar };
}
