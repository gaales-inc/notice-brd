/**
 * The dashboard's API: boards, their messages, screens and people.
 *
 * Everyone on a board — its owner and its collaborators — can write and
 * broadcast messages and add, rename and remove screens. Only the owner can
 * rename or delete the board and choose who else is on it.
 */
import { NextFunction, Response, Router } from "express";
import {
  DEFAULT_STYLE,
  isColor,
  isSize,
  isSpeed,
  MAX_BOARD_NAME,
  MAX_MESSAGE_LENGTH,
  MAX_SCREEN_NAME,
} from "../shared/style";
import { AuthedRequest, normalizeEmail, requireUser } from "./auth";
import { Mailer } from "./mailr";
import { openStream } from "./hub";
import { Live, normalizePairCode } from "./screens";

export const MAX_BOARDS_OWNED = 25;
export const MAX_MEMBERS = 50;
export const MAX_MESSAGES = 200;

type Role = "owner" | "collaborator";

interface BoardRequest extends AuthedRequest {
  boardId?: string;
  role?: Role;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name && name.length <= max ? name : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // One line: it runs across the screen. Line breaks become spaces.
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text && text.length <= MAX_MESSAGE_LENGTH ? text : null;
}

export function boardsRouter(live: Live, mailer: Mailer, appUrl: string): Router {
  const { db, hub } = live;
  const router = Router();
  router.use(requireUser(db));

  /** Loads the caller's role on :boardId; 404 for a board they aren't on. */
  async function onBoard(req: BoardRequest, res: Response, next: NextFunction) {
    const boardId = String(req.params.boardId ?? "");
    if (!UUID.test(boardId)) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    const { rows } = await db.query<{ role: Role }>(
      "SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2",
      [boardId, req.user!.id]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    req.boardId = boardId;
    req.role = rows[0].role;
    next();
  }

  function ownerOnly(req: BoardRequest, res: Response, next: NextFunction) {
    if (req.role !== "owner") {
      res.status(403).json({ error: "Only the board's owner can do that." });
      return;
    }
    next();
  }

  // -------------------------------------------------------------------- boards

  router.get("/boards", async (req: AuthedRequest, res: Response) => {
    const { rows: boards } = await db.query<{ id: string; name: string; role: Role; created_at: Date }>(
      `SELECT b.id, b.name, m.role, b.created_at
         FROM board_members m JOIN boards b ON b.id = m.board_id
        WHERE m.user_id = $1
        ORDER BY b.created_at`,
      [req.user!.id]
    );
    const { rows: screens } = await db.query<{ id: string; board_id: string; message_id: string | null }>(
      `SELECT s.id, s.board_id, s.message_id
         FROM screens s JOIN board_members m ON m.board_id = s.board_id
        WHERE m.user_id = $1`,
      [req.user!.id]
    );
    res.json({
      boards: boards.map((b) => {
        const mine = screens.filter((s) => s.board_id === b.id);
        const statuses = mine.map((s) => hub.status(s.id));
        return {
          id: b.id,
          name: b.name,
          role: b.role,
          createdAt: b.created_at,
          screens: mine.length,
          awake: statuses.filter((s) => s === "awake").length,
          open: statuses.filter((s) => s !== "offline").length,
          onAir: mine.filter((s) => s.message_id).length,
        };
      }),
    });
  });

  router.post("/boards", async (req: AuthedRequest, res: Response) => {
    const name = cleanName(req.body?.name, MAX_BOARD_NAME);
    if (!name) {
      res.status(400).json({ error: `Give the board a name of up to ${MAX_BOARD_NAME} characters.` });
      return;
    }
    const { rows: owned } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM board_members WHERE user_id = $1 AND role = 'owner'",
      [req.user!.id]
    );
    if (owned[0]!.n >= MAX_BOARDS_OWNED) {
      res.status(400).json({ error: `You can own up to ${MAX_BOARDS_OWNED} boards.` });
      return;
    }
    const board = await db.transaction(async (q) => {
      const { rows } = await q.query<{ id: string; name: string }>(
        "INSERT INTO boards (name) VALUES ($1) RETURNING id, name",
        [name]
      );
      await q.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')", [
        rows[0]!.id,
        req.user!.id,
      ]);
      return rows[0]!;
    });
    res.status(201).json({ board: { ...board, role: "owner" } });
  });

  /** The whole board as the dashboard draws it. */
  router.get("/boards/:boardId", onBoard, async (req: BoardRequest, res: Response) => {
    const boardId = req.boardId!;
    const [{ rows: boards }, { rows: members }, { rows: messages }, { rows: screens }] = await Promise.all([
      db.query<{ id: string; name: string; created_at: Date }>("SELECT id, name, created_at FROM boards WHERE id = $1", [
        boardId,
      ]),
      db.query<{ user_id: string; email: string; role: Role; pending: boolean }>(
        `SELECT u.id AS user_id, u.email, m.role, u.verified_at IS NULL AS pending
           FROM board_members m JOIN users u ON u.id = m.user_id
          WHERE m.board_id = $1
          ORDER BY m.role = 'owner' DESC, m.added_at`,
        [boardId]
      ),
      db.query<{ id: string; text: string; color: string; speed: string; size: string; created_at: Date; updated_at: Date }>(
        `SELECT id, text, color, speed, size, created_at, updated_at
           FROM messages WHERE board_id = $1 ORDER BY created_at DESC`,
        [boardId]
      ),
      db.query<{ id: string; name: string; device: string; message_id: string | null; paired_at: Date; last_seen_at: Date | null }>(
        `SELECT id, name, device, message_id, paired_at, last_seen_at
           FROM screens WHERE board_id = $1 ORDER BY paired_at, id`,
        [boardId]
      ),
    ]);
    const board = boards[0]!;

    res.json({
      board: { id: board.id, name: board.name, createdAt: board.created_at },
      role: req.role,
      me: req.user!.id,
      members: members.map((m) => ({ userId: m.user_id, email: m.email, role: m.role, pending: m.pending })),
      messages: messages.map((m) => ({
        id: m.id,
        text: m.text,
        color: m.color,
        speed: m.speed,
        size: m.size,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        screenIds: screens.filter((s) => s.message_id === m.id).map((s) => s.id),
      })),
      screens: screens.map((s) => {
        const seen = hub.lastSeen(s.id);
        const stored = s.last_seen_at ? new Date(s.last_seen_at).getTime() : null;
        const lastSeen = Math.max(seen ?? 0, stored ?? 0);
        return {
          id: s.id,
          name: s.name,
          device: s.device,
          messageId: s.message_id,
          pairedAt: s.paired_at,
          status: hub.status(s.id),
          lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
        };
      }),
    });
  });

  /** Tells the dashboard when to reload the board. */
  router.get("/boards/:boardId/events", onBoard, (req: BoardRequest, res: Response) => {
    let unsubscribe = () => {};
    const send = openStream(res, () => unsubscribe());
    unsubscribe = hub.subscribeBoard(req.boardId!, () => send("changed", {}));
    send("ready", {});
  });

  router.patch("/boards/:boardId", onBoard, ownerOnly, async (req: BoardRequest, res: Response) => {
    const name = cleanName(req.body?.name, MAX_BOARD_NAME);
    if (!name) {
      res.status(400).json({ error: `Give the board a name of up to ${MAX_BOARD_NAME} characters.` });
      return;
    }
    await db.query("UPDATE boards SET name = $2 WHERE id = $1", [req.boardId, name]);
    await live.boardChanged(req.boardId!);
    res.json({ ok: true });
  });

  router.delete("/boards/:boardId", onBoard, ownerOnly, async (req: BoardRequest, res: Response) => {
    // Its screens go back to showing a pair code rather than vanishing.
    const { rows: screens } = await db.query<{ id: string }>("SELECT id FROM screens WHERE board_id = $1", [req.boardId]);
    for (const s of screens) await live.unpair(s.id);
    await db.query("DELETE FROM boards WHERE id = $1", [req.boardId]);
    hub.notifyBoard(req.boardId!);
    res.status(204).end();
  });

  // ------------------------------------------------------------------ messages

  router.post("/boards/:boardId/messages", onBoard, async (req: BoardRequest, res: Response) => {
    const text = cleanText(req.body?.text);
    if (!text) {
      res.status(400).json({ error: `Write a message of up to ${MAX_MESSAGE_LENGTH} characters.` });
      return;
    }
    const color = req.body?.color ?? DEFAULT_STYLE.color;
    const speed = req.body?.speed ?? DEFAULT_STYLE.speed;
    const size = req.body?.size ?? DEFAULT_STYLE.size;
    if (!isColor(color) || !isSpeed(speed) || !isSize(size)) {
      res.status(400).json({ error: "That colour, speed or size isn't one NoticeBrd knows." });
      return;
    }
    const { rows: count } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM messages WHERE board_id = $1", [
      req.boardId,
    ]);
    if (count[0]!.n >= MAX_MESSAGES) {
      res.status(400).json({ error: `A board can keep up to ${MAX_MESSAGES} messages. Delete some old ones first.` });
      return;
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO messages (board_id, text, color, speed, size, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.boardId, text, color, speed, size, req.user!.id]
    );
    hub.notifyBoard(req.boardId!);
    res.status(201).json({ message: { id: rows[0]!.id, text, color, speed, size } });
  });

  router.patch("/boards/:boardId/messages/:messageId", onBoard, async (req: BoardRequest, res: Response) => {
    const body = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [req.boardId, req.params.messageId];
    if (body.text !== undefined) {
      const text = cleanText(body.text);
      if (!text) {
        res.status(400).json({ error: `Write a message of up to ${MAX_MESSAGE_LENGTH} characters.` });
        return;
      }
      params.push(text);
      sets.push(`text = $${params.length}`);
    }
    for (const [field, valid] of [
      ["color", isColor],
      ["speed", isSpeed],
      ["size", isSize],
    ] as const) {
      if (body[field] === undefined) continue;
      if (!valid(body[field])) {
        res.status(400).json({ error: "That colour, speed or size isn't one NoticeBrd knows." });
        return;
      }
      params.push(body[field]);
      sets.push(`${field} = $${params.length}`);
    }
    if (!sets.length || !UUID.test(String(req.params.messageId))) {
      res.status(400).json({ error: "Nothing to change." });
      return;
    }
    const { rows } = await db.query(
      `UPDATE messages SET ${sets.join(", ")}, updated_at = NOW() WHERE board_id = $1 AND id = $2 RETURNING id`,
      params
    );
    if (!rows.length) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    await live.boardChanged(req.boardId!);
    res.json({ ok: true });
  });

  router.delete("/boards/:boardId/messages/:messageId", onBoard, async (req: BoardRequest, res: Response) => {
    if (!UUID.test(String(req.params.messageId))) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    // Screens showing it go black (the foreign key sets their message to NULL).
    await db.query("DELETE FROM messages WHERE board_id = $1 AND id = $2", [req.boardId, req.params.messageId]);
    await live.boardChanged(req.boardId!);
    res.status(204).end();
  });

  /**
   * Broadcasts a message on exactly these screens: each one listed switches to
   * it (from whatever it showed), and any other screen showing it goes black.
   */
  router.post("/boards/:boardId/messages/:messageId/broadcast", onBoard, async (req: BoardRequest, res: Response) => {
    const messageId = String(req.params.messageId);
    const screenIds = req.body?.screenIds;
    if (!Array.isArray(screenIds) || screenIds.length > 500 || !screenIds.every((id) => typeof id === "string" && UUID.test(id))) {
      res.status(400).json({ error: "Choose the screens to broadcast on." });
      return;
    }
    if (!UUID.test(messageId)) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const ok = await db.transaction(async (q) => {
      const { rows } = await q.query("SELECT 1 FROM messages WHERE board_id = $1 AND id = $2", [req.boardId, messageId]);
      if (!rows.length) return false;
      const ids = JSON.stringify(screenIds);
      await q.query(
        `UPDATE screens SET message_id = NULL
          WHERE board_id = $1 AND message_id = $2
            AND id NOT IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid)`,
        [req.boardId, messageId, ids]
      );
      await q.query(
        `UPDATE screens SET message_id = $2
          WHERE board_id = $1 AND id IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid)`,
        [req.boardId, messageId, ids]
      );
      return true;
    });
    if (!ok) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    await live.boardChanged(req.boardId!);
    res.json({ ok: true });
  });

  /** Takes a message off every screen showing it. */
  router.post("/boards/:boardId/messages/:messageId/stop", onBoard, async (req: BoardRequest, res: Response) => {
    if (!UUID.test(String(req.params.messageId))) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    await db.query("UPDATE screens SET message_id = NULL WHERE board_id = $1 AND message_id = $2", [
      req.boardId,
      req.params.messageId,
    ]);
    await live.boardChanged(req.boardId!);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------- screens

  /** Pairs the screen showing this code with the board. */
  router.post("/boards/:boardId/screens", onBoard, async (req: BoardRequest, res: Response) => {
    const code = normalizePairCode(req.body?.code);
    const name = req.body?.name === undefined || req.body?.name === "" ? "" : cleanName(req.body.name, MAX_SCREEN_NAME);
    if (name === null) {
      res.status(400).json({ error: `Screen names can be up to ${MAX_SCREEN_NAME} characters.` });
      return;
    }
    if (code.length !== 6) {
      res.status(400).json({ error: "Enter the 6-character code shown on the screen." });
      return;
    }
    const screen = await db.transaction(async (q) => {
      const { rows } = await q.query<{ id: string; device: string }>(
        `SELECT id, device FROM screens
          WHERE pair_code = $1 AND pair_expires_at > NOW() AND board_id IS NULL
          FOR UPDATE`,
        [code]
      );
      const found = rows[0];
      if (!found) return null;
      const { rows: count } = await q.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM screens WHERE board_id = $1", [
        req.boardId,
      ]);
      const finalName = name || found.device || `Screen ${count[0]!.n + 1}`;
      await q.query(
        `UPDATE screens
            SET board_id = $2, name = $3, pair_code = NULL, pair_expires_at = NULL, message_id = NULL, paired_at = NOW()
          WHERE id = $1`,
        [found.id, req.boardId, finalName.slice(0, MAX_SCREEN_NAME)]
      );
      return { id: found.id, name: finalName };
    });
    if (!screen) {
      res.status(404).json({ error: "No screen is showing that code. Check it on the screen — codes change every 30 minutes." });
      return;
    }
    hub.moved(screen.id, null, req.boardId!);
    await live.pushScreen(screen.id);
    res.status(201).json({ screen });
  });

  /** Renames a screen, or sets what it shows (`messageId: null` is the black screen). */
  router.patch("/boards/:boardId/screens/:screenId", onBoard, async (req: BoardRequest, res: Response) => {
    const screenId = String(req.params.screenId);
    const body = req.body ?? {};
    if (!UUID.test(screenId)) {
      res.status(404).json({ error: "Screen not found" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [req.boardId, screenId];
    if (body.name !== undefined) {
      const name = cleanName(body.name, MAX_SCREEN_NAME);
      if (!name) {
        res.status(400).json({ error: `Give the screen a name of up to ${MAX_SCREEN_NAME} characters.` });
        return;
      }
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (body.messageId !== undefined) {
      if (body.messageId !== null) {
        const ok =
          typeof body.messageId === "string" &&
          UUID.test(body.messageId) &&
          (await db.query("SELECT 1 FROM messages WHERE board_id = $1 AND id = $2", [req.boardId, body.messageId])).rows.length;
        if (!ok) {
          res.status(400).json({ error: "That message isn't on this board." });
          return;
        }
      }
      params.push(body.messageId);
      sets.push(`message_id = $${params.length}`);
    }
    if (!sets.length) {
      res.status(400).json({ error: "Nothing to change." });
      return;
    }
    const { rows } = await db.query(
      `UPDATE screens SET ${sets.join(", ")} WHERE board_id = $1 AND id = $2 RETURNING id`,
      params
    );
    if (!rows.length) {
      res.status(404).json({ error: "Screen not found" });
      return;
    }
    hub.notifyBoard(req.boardId!);
    await live.pushScreen(screenId);
    res.json({ ok: true });
  });

  /** Removes a screen from the board; it goes back to showing a pair code. */
  router.delete("/boards/:boardId/screens/:screenId", onBoard, async (req: BoardRequest, res: Response) => {
    const screenId = String(req.params.screenId);
    const found =
      UUID.test(screenId) &&
      (await db.query("SELECT 1 FROM screens WHERE board_id = $1 AND id = $2", [req.boardId, screenId])).rows.length;
    if (!found) {
      res.status(404).json({ error: "Screen not found" });
      return;
    }
    await live.unpair(screenId);
    res.status(204).end();
  });

  // -------------------------------------------------------------------- people

  router.post("/boards/:boardId/members", onBoard, ownerOnly, async (req: BoardRequest, res: Response) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }
    const { rows: count } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM board_members WHERE board_id = $1",
      [req.boardId]
    );
    if (count[0]!.n >= MAX_MEMBERS) {
      res.status(400).json({ error: `A board can have up to ${MAX_MEMBERS} people.` });
      return;
    }
    const added = await db.transaction(async (q) => {
      // Someone who has never signed in gets a user row now, unverified: the
      // code they're sent when they first sign in is what verifies it.
      const { rows: users } = await q.query<{ id: string }>(
        `INSERT INTO users (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [email]
      );
      const { rows } = await q.query(
        `INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'collaborator')
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [req.boardId, users[0]!.id]
      );
      return rows.length ? users[0]!.id : null;
    });
    if (!added) {
      res.status(409).json({ error: `${email} is already on this board.` });
      return;
    }

    const { rows: boards } = await db.query<{ name: string }>("SELECT name FROM boards WHERE id = $1", [req.boardId]);
    const boardName = boards[0]?.name ?? "a board";
    let emailed = true;
    try {
      await mailer({
        to: email,
        subject: `${req.user!.email} added you to “${boardName}” on NoticeBrd`,
        brand: "noticebrd",
        preheader: `You can now write and broadcast messages on “${boardName}”.`,
        footer_note: "You received this because the owner of a NoticeBrd board added this address to it.",
        blocks: [
          { type: "heading", text: `You're on “${boardName}”` },
          {
            type: "text",
            text: `${req.user!.email} added you to their NoticeBrd board. You can write messages and choose which screens they run across.`,
          },
          { type: "button", label: "Open the dashboard", url: `${appUrl}/dashboard` },
          { type: "note", text: "Or paste this link into your browser:" },
          { type: "link", url: `${appUrl}/dashboard` },
          { type: "divider" },
          { type: "note", text: `Sign in with ${email} — NoticeBrd emails you a code, so there's no password to remember.` },
        ],
      });
    } catch (err) {
      console.error("Failed to send invitation:", err);
      emailed = false;
    }
    hub.notifyBoard(req.boardId!);
    res.status(201).json({ member: { userId: added, email, role: "collaborator" }, emailed });
  });

  router.delete("/boards/:boardId/members/:userId", onBoard, async (req: BoardRequest, res: Response) => {
    const userId = String(req.params.userId);
    const self = userId === req.user!.id;
    if (!self && req.role !== "owner") {
      res.status(403).json({ error: "Only the board's owner can remove people." });
      return;
    }
    if (self && req.role === "owner") {
      res.status(400).json({ error: "The owner can't leave their own board. Delete it instead." });
      return;
    }
    const { rows } = UUID.test(userId)
      ? await db.query("DELETE FROM board_members WHERE board_id = $1 AND user_id = $2 AND role = 'collaborator' RETURNING user_id", [
          req.boardId,
          userId,
        ])
      : { rows: [] };
    if (!rows.length) {
      res.status(404).json({ error: "They aren't on this board." });
      return;
    }
    hub.notifyBoard(req.boardId!);
    res.status(204).end();
  });

  return router;
}
