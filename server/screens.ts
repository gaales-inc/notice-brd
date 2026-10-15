/**
 * Screens: the browsers that show a board.
 *
 * A screen needs no account. Opening /screen gives the browser a screen of its
 * own — a random token in an HttpOnly cookie — and, until a board member pairs
 * it, a six-character code to show. Entering that code in the dashboard puts
 * the screen on the board; from then on the screen is told, over its event
 * stream, what to show.
 */
import { randomInt } from "crypto";
import { Request, Response, Router } from "express";
import { newToken, sha256 } from "./auth";
import { readCookie, SCREEN_COOKIE, setCookie } from "./cookies";
import { Db, Queryable } from "./db";
import { Hub, openStream } from "./hub";

export const PAIR_CODE_TTL_MINUTES = 30;
/** Browsers cap a cookie at 400 days; every visit renews it. */
const SCREEN_COOKIE_DAYS = 400;
const SCREEN_COOKIE_PATH = "/api/screen";
/** No 0/O, 1/I/L: the code is read off a screen across a room. */
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface ScreenMessage {
  id: string;
  text: string;
  color: string;
  speed: string;
  size: string;
}

/** Everything a screen needs to draw itself. */
export interface ScreenState {
  /** The build the server is running; a screen on an older one reloads. */
  version: string;
  screen: { id: string; name: string };
  paired: boolean;
  pairCode: string | null;
  pairExpiresAt: string | null;
  board: { name: string } | null;
  /** What it is broadcasting; null is the black screen. */
  message: ScreenMessage | null;
}

interface ScreenRow {
  id: string;
  name: string;
  board_id: string | null;
  board_name: string | null;
  pair_code: string | null;
  pair_expires_at: Date | null;
  message_id: string | null;
  text: string | null;
  color: string | null;
  speed: string | null;
  size: string | null;
}

const SCREEN_SELECT = `
  SELECT s.id, s.name, s.board_id, b.name AS board_name, s.pair_code, s.pair_expires_at,
         m.id AS message_id, m.text, m.color, m.speed, m.size
    FROM screens s
    LEFT JOIN boards b ON b.id = s.board_id
    LEFT JOIN messages m ON m.id = s.message_id`;

export function normalizePairCode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

export function cleanDeviceName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
}

/** Server state shared by the routers: the database, live connections and the build. */
export class Live {
  constructor(
    readonly db: Db,
    readonly hub: Hub,
    readonly version: string
  ) {}

  private toState(row: ScreenRow): ScreenState {
    const paired = row.board_id !== null;
    return {
      version: this.version,
      screen: { id: row.id, name: row.name },
      paired,
      pairCode: paired ? null : row.pair_code,
      pairExpiresAt: paired || !row.pair_expires_at ? null : new Date(row.pair_expires_at).toISOString(),
      board: paired ? { name: row.board_name ?? "" } : null,
      message:
        row.message_id && row.text !== null
          ? { id: row.message_id, text: row.text, color: row.color!, speed: row.speed!, size: row.size! }
          : null,
    };
  }

  async screenState(screenId: string): Promise<ScreenState | null> {
    const { rows } = await this.db.query<ScreenRow>(`${SCREEN_SELECT} WHERE s.id = $1`, [screenId]);
    return rows[0] ? this.toState(rows[0]) : null;
  }

  async pushScreen(screenId: string) {
    if (!this.hub.isListening(screenId)) return;
    const state = await this.screenState(screenId);
    if (state) this.hub.sendScreen(screenId, "state", state);
  }

  /** After any change to a board: its dashboards reload, its screens redraw. */
  async boardChanged(boardId: string) {
    this.hub.notifyBoard(boardId);
    const { rows } = await this.db.query<ScreenRow>(`${SCREEN_SELECT} WHERE s.board_id = $1`, [boardId]);
    for (const row of rows) if (this.hub.isListening(row.id)) this.hub.sendScreen(row.id, "state", this.toState(row));
  }

  /** Gives an unpaired screen a fresh code. Codes are unique while they live. */
  async issuePairCode(screenId: string, q: Queryable = this.db) {
    for (let attempt = 0; ; attempt++) {
      let code = "";
      for (let i = 0; i < 6; i++) code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
      try {
        // An expired code may still hold the unique slot; it is fair game.
        await q.query("UPDATE screens SET pair_code = NULL WHERE pair_code = $1 AND pair_expires_at < NOW()", [code]);
        await q.query(
          "UPDATE screens SET pair_code = $2, pair_expires_at = $3::timestamptz WHERE id = $1",
          [screenId, code, new Date(Date.now() + PAIR_CODE_TTL_MINUTES * 60_000).toISOString()]
        );
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== "23505" || attempt >= 5) throw err;
      }
    }
  }

  /** Takes a screen off its board. It shows a new pair code straight away. */
  async unpair(screenId: string) {
    const { rows } = await this.db.query<{ board_id: string | null }>("SELECT board_id FROM screens WHERE id = $1", [screenId]);
    await this.db.query(
      "UPDATE screens SET board_id = NULL, message_id = NULL, name = '', paired_at = NULL WHERE id = $1",
      [screenId]
    );
    await this.issuePairCode(screenId);
    this.hub.moved(screenId, rows[0]?.board_id ?? null, null);
    await this.pushScreen(screenId);
  }
}

async function screenFromCookie(db: Db, req: Request): Promise<{ id: string; board_id: string | null } | null> {
  const token = readCookie(req, SCREEN_COOKIE);
  if (!token) return null;
  const { rows } = await db.query<{ id: string; board_id: string | null }>(
    "SELECT id, board_id FROM screens WHERE token_hash = $1",
    [sha256(token)]
  );
  return rows[0] ?? null;
}

/** The endpoints a screen calls about itself, under /api/screen. */
export function screenRouter(live: Live): Router {
  const { db, hub } = live;
  const router = Router();

  /** Opening the screen page: finds this browser's screen, or makes one. */
  router.post("/hello", async (req: Request, res: Response) => {
    const device = cleanDeviceName(req.body?.device);
    let screen = await screenFromCookie(db, req);
    let token = readCookie(req, SCREEN_COOKIE);

    if (!screen) {
      token = newToken();
      const { rows } = await db.query<{ id: string; board_id: string | null }>(
        "INSERT INTO screens (token_hash, device, last_seen_at) VALUES ($1, $2, NOW()) RETURNING id, board_id",
        [sha256(token), device]
      );
      screen = rows[0]!;
    } else {
      await db.query("UPDATE screens SET device = COALESCE(NULLIF($2, ''), device), last_seen_at = NOW() WHERE id = $1", [
        screen.id,
        device,
      ]);
    }
    setCookie(res, SCREEN_COOKIE, token, { path: SCREEN_COOKIE_PATH, maxAgeDays: SCREEN_COOKIE_DAYS });

    if (!screen.board_id) {
      const { rows } = await db.query<{ live: boolean }>(
        "SELECT pair_code IS NOT NULL AND pair_expires_at > NOW() + INTERVAL '1 minute' AS live FROM screens WHERE id = $1",
        [screen.id]
      );
      if (!rows[0]?.live) await live.issuePairCode(screen.id);
    }

    hub.seen(screen.id, screen.board_id);
    res.json(await live.screenState(screen.id));
  });

  /** The push channel: a `state` event now and after every change. */
  router.get("/events", async (req: Request, res: Response) => {
    const screen = await screenFromCookie(db, req);
    if (!screen) {
      res.status(401).json({ error: "Unknown screen" });
      return;
    }
    let unsubscribe = () => {};
    const send = openStream(res, () => unsubscribe());
    unsubscribe = hub.subscribeScreen(screen.id, send);
    hub.seen(screen.id, screen.board_id);
    const state = await live.screenState(screen.id);
    if (state) send("state", state);
  });

  /**
   * The heartbeat, and the report of a change in it. Answers with the state,
   * so a screen whose event stream is blocked still catches up within 20 s.
   * `{ open: false }` is the beacon sent as the page closes.
   */
  router.post("/status", async (req: Request, res: Response) => {
    const screen = await screenFromCookie(db, req);
    if (!screen) {
      res.status(401).json({ error: "Unknown screen" });
      return;
    }
    if (req.body?.open === false) {
      hub.closed(screen.id);
      res.status(204).end();
      return;
    }
    await db.query("UPDATE screens SET last_seen_at = NOW() WHERE id = $1", [screen.id]);
    hub.seen(screen.id, screen.board_id, { awake: req.body?.awake === true, visible: req.body?.visible !== false });
    res.json(await live.screenState(screen.id));
  });

  /** "Unpair this screen", from the screen itself. */
  router.post("/unpair", async (req: Request, res: Response) => {
    const screen = await screenFromCookie(db, req);
    if (!screen) {
      res.status(401).json({ error: "Unknown screen" });
      return;
    }
    if (screen.board_id) await live.unpair(screen.id);
    res.json(await live.screenState(screen.id));
  });

  return router;
}
