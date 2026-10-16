import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ONLINE_WINDOW_MS } from "../server/hub";
import { GOOGLE_FEED } from "./fixtures";
import { codeFrom, createContext, openScreen, signIn, TestContext } from "./helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createContext();
});

afterEach(async () => {
  ctx.hub.stop();
  await ctx.db.close();
});

async function makeBoard(name = "Lobby") {
  const owner = await signIn(ctx, "owner@example.com");
  const res = await owner.agent.post("/api/boards").send({ name }).expect(201);
  return { owner, boardId: res.body.board.id as string };
}

async function pair(owner: { agent: ReturnType<typeof request.agent> }, boardId: string, name?: string) {
  const screen = await openScreen(ctx);
  const res = await owner.agent
    .post(`/api/boards/${boardId}/screens`)
    .send({ code: screen.state.pairCode, name })
    .expect(201);
  return { ...screen, id: res.body.screen.id as string };
}

describe("sign-in", () => {
  it("emails a code and exchanges it for a session cookie", async () => {
    const agent = request.agent(ctx.app);
    await agent.get("/api/auth/me").expect(401);
    await agent.post("/api/auth/code").send({ email: " Someone@Example.com " }).expect(200);
    expect(ctx.mails[0]!.to).toBe("someone@example.com");
    expect(ctx.mails[0]!.subject).toContain("NoticeBrd");

    await agent.post("/api/auth/verify").send({ email: "someone@example.com", code: "000000" }).expect(401);
    const res = await agent
      .post("/api/auth/verify")
      .send({ email: "someone@example.com", code: codeFrom(ctx.mails, "someone@example.com") })
      .expect(200);
    expect(res.headers["set-cookie"]![0]).toMatch(/nb_session=.*HttpOnly/);

    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.user.email).toBe("someone@example.com");

    await agent.post("/api/auth/logout").expect(200);
    await agent.get("/api/auth/me").expect(401);
  });

  it("burns a code after five wrong guesses", async () => {
    const email = "guess@example.com";
    await request(ctx.app).post("/api/auth/code").send({ email }).expect(200);
    const code = codeFrom(ctx.mails, email);
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) await request(ctx.app).post("/api/auth/verify").send({ email, code: wrong }).expect(401);
    await request(ctx.app).post("/api/auth/verify").send({ email, code }).expect(401);
  });

  it("refuses writes from another site", async () => {
    await request(ctx.app)
      .post("/api/auth/code")
      .set("Origin", "https://evil.example")
      .send({ email: "a@example.com" })
      .expect(403);
  });

  it("keeps the dashboard API behind sign-in", async () => {
    await request(ctx.app).get("/api/boards").expect(401);
  });
});

describe("boards", () => {
  it("creates a board owned by its creator and lists it", async () => {
    const { owner, boardId } = await makeBoard("Front window");
    const list = await owner.agent.get("/api/boards").expect(200);
    expect(list.body.boards).toEqual([
      expect.objectContaining({ id: boardId, name: "Front window", role: "owner", screens: 0, onAir: 0 }),
    ]);
  });

  it("hides a board from people who aren't on it", async () => {
    const { boardId } = await makeBoard();
    const stranger = await signIn(ctx, "stranger@example.com");
    await stranger.agent.get(`/api/boards/${boardId}`).expect(404);
    await stranger.agent.post(`/api/boards/${boardId}/messages`).send({ text: "hi" }).expect(404);
    await stranger.agent.get("/api/boards/not-a-uuid").expect(404);
  });
});

describe("screens", () => {
  it("gives a new screen a pair code, then the board once paired", async () => {
    const { owner, boardId } = await makeBoard("Hall");
    const screen = await openScreen(ctx, "Android · Chrome");
    expect(screen.state.paired).toBe(false);
    expect(screen.state.pairCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    // The same browser keeps its screen and its code.
    const again = await screen.agent.post("/api/screen/hello").send({}).expect(200);
    expect(again.body.screen.id).toBe(screen.state.screen.id);
    expect(again.body.pairCode).toBe(screen.state.pairCode);

    await owner.agent.post(`/api/boards/${boardId}/screens`).send({ code: "ZZZZZZ" }).expect(404);
    const code = screen.state.pairCode.toLowerCase().replace(/(...)/, "$1 ");
    const res = await owner.agent.post(`/api/boards/${boardId}/screens`).send({ code }).expect(201);
    expect(res.body.screen.name).toBe("Android · Chrome");

    const state = await screen.agent.post("/api/screen/status").send({ awake: true }).expect(200);
    expect(state.body).toMatchObject({ paired: true, pairCode: null, board: { name: "Hall" }, message: null });

    // A code works once.
    await owner.agent.post(`/api/boards/${boardId}/screens`).send({ code }).expect(404);
  });

  it("shows which screens are awake, open or gone", async () => {
    const { owner, boardId } = await makeBoard();
    const tv = await pair(owner, boardId, "Lobby TV");
    const phone = await pair(owner, boardId, "Window phone");
    const status = async () => {
      const res = await owner.agent.get(`/api/boards/${boardId}`).expect(200);
      return Object.fromEntries(res.body.screens.map((s: { name: string; status: string }) => [s.name, s.status]));
    };

    await tv.agent.post("/api/screen/status").send({ awake: true, visible: true }).expect(200);
    await phone.agent.post("/api/screen/status").send({ awake: false, visible: true }).expect(200);
    expect(await status()).toEqual({ "Lobby TV": "awake", "Window phone": "open" });

    // The phone's tab closes; the TV's heartbeats stop.
    await phone.agent.post("/api/screen/status").send({ open: false }).expect(204);
    ctx.clock.now += ONLINE_WINDOW_MS + 1000;
    expect(await status()).toEqual({ "Lobby TV": "offline", "Window phone": "offline" });

    const res = await owner.agent.get(`/api/boards/${boardId}`).expect(200);
    expect(res.body.screens[0].lastSeenAt).toBeTruthy();
  });

  it("goes back to a pair code when removed from the board", async () => {
    const { owner, boardId } = await makeBoard();
    const screen = await pair(owner, boardId);
    await owner.agent.delete(`/api/boards/${boardId}/screens/${screen.id}`).expect(204);
    const state = await screen.agent.post("/api/screen/status").send({}).expect(200);
    expect(state.body.paired).toBe(false);
    expect(state.body.pairCode).toMatch(/^[A-Z0-9]{6}$/);
    const board = await owner.agent.get(`/api/boards/${boardId}`).expect(200);
    expect(board.body.screens).toEqual([]);
  });

  it("can unpair itself", async () => {
    const { owner, boardId } = await makeBoard();
    const screen = await pair(owner, boardId);
    const res = await screen.agent.post("/api/screen/unpair").expect(200);
    expect(res.body.paired).toBe(false);
    const board = await owner.agent.get(`/api/boards/${boardId}`).expect(200);
    expect(board.body.screens).toEqual([]);
  });

  it("refuses screen calls without the screen's cookie", async () => {
    await request(ctx.app).post("/api/screen/status").send({ awake: true }).expect(401);
    await request(ctx.app).get("/api/screen/events").expect(401);
  });
});

describe("messages and broadcasting", () => {
  it("broadcasts a message on chosen screens and shows where it is on", async () => {
    const { owner, boardId } = await makeBoard();
    const a = await pair(owner, boardId, "A");
    const b = await pair(owner, boardId, "B");

    const created = await owner.agent
      .post(`/api/boards/${boardId}/messages`)
      .send({ text: "Service starts\nat 10", color: "#ff453a", speed: "fast", size: "large" })
      .expect(201);
    const messageId = created.body.message.id;
    expect(created.body.message.text).toBe("Service starts at 10");

    await owner.agent.post(`/api/boards/${boardId}/messages/${messageId}/broadcast`).send({ screenIds: [a.id] }).expect(200);
    let board = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body;
    expect(board.messages[0].screenIds).toEqual([a.id]);

    const onA = (await a.agent.post("/api/screen/status").send({ awake: true }).expect(200)).body;
    expect(onA.message).toMatchObject({ text: "Service starts at 10", color: "#ff453a", speed: "fast", size: "large" });
    const onB = (await b.agent.post("/api/screen/status").send({ awake: true }).expect(200)).body;
    expect(onB.message).toBeNull();

    // Broadcasting again names the full set: B on, A off.
    await owner.agent.post(`/api/boards/${boardId}/messages/${messageId}/broadcast`).send({ screenIds: [b.id] }).expect(200);
    board = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body;
    expect(board.messages[0].screenIds).toEqual([b.id]);

    // Editing it changes what the screen shows.
    await owner.agent.patch(`/api/boards/${boardId}/messages/${messageId}`).send({ text: "Moved to 11" }).expect(200);
    expect((await b.agent.post("/api/screen/status").send({}).expect(200)).body.message.text).toBe("Moved to 11");

    await owner.agent.post(`/api/boards/${boardId}/messages/${messageId}/stop`).expect(200);
    expect((await b.agent.post("/api/screen/status").send({}).expect(200)).body.message).toBeNull();
  });

  it("turns a screen black when its message is deleted", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    const { body } = await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Hello" }).expect(201);
    await owner.agent.patch(`/api/boards/${boardId}/screens/${s.id}`).send({ messageId: body.message.id }).expect(200);
    expect((await s.agent.post("/api/screen/status").send({}).expect(200)).body.message.text).toBe("Hello");
    await owner.agent.delete(`/api/boards/${boardId}/messages/${body.message.id}`).expect(204);
    expect((await s.agent.post("/api/screen/status").send({}).expect(200)).body.message).toBeNull();
  });

  it("only broadcasts on the board's own screens", async () => {
    const { owner, boardId } = await makeBoard();
    const other = await owner.agent.post("/api/boards").send({ name: "Other" }).expect(201);
    const elsewhere = await pair(owner, other.body.board.id);
    const { body } = await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Mine" }).expect(201);
    await owner.agent
      .post(`/api/boards/${boardId}/messages/${body.message.id}/broadcast`)
      .send({ screenIds: [elsewhere.id] })
      .expect(200);
    expect((await elsewhere.agent.post("/api/screen/status").send({}).expect(200)).body.message).toBeNull();
  });

  it("validates messages", async () => {
    const { owner, boardId } = await makeBoard();
    await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "   " }).expect(400);
    await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "x".repeat(501) }).expect(400);
    await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Hi", color: "red" }).expect(400);
    await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Hi", speed: "warp" }).expect(400);
  });
});

describe("collaborators", () => {
  it("lets the owner add a collaborator who can broadcast but not manage the board", async () => {
    const { owner, boardId } = await makeBoard("Church");
    const screen = await pair(owner, boardId);
    const added = await owner.agent.post(`/api/boards/${boardId}/members`).send({ email: "Helper@Example.com" }).expect(201);
    expect(added.body.emailed).toBe(true);
    const invite = ctx.mails.find((m) => m.to === "helper@example.com")!;
    expect(invite.subject).toContain("Church");

    await owner.agent.post(`/api/boards/${boardId}/members`).send({ email: "helper@example.com" }).expect(409);

    const helper = await signIn(ctx, "helper@example.com");
    const board = (await helper.agent.get(`/api/boards/${boardId}`).expect(200)).body;
    expect(board.role).toBe("collaborator");
    expect(board.members.map((m: { email: string; pending: boolean }) => [m.email, m.pending])).toEqual([
      ["owner@example.com", false],
      ["helper@example.com", false],
    ]);

    const { body } = await helper.agent.post(`/api/boards/${boardId}/messages`).send({ text: "From the helper" }).expect(201);
    await helper.agent
      .post(`/api/boards/${boardId}/messages/${body.message.id}/broadcast`)
      .send({ screenIds: [screen.id] })
      .expect(200);

    await helper.agent.patch(`/api/boards/${boardId}`).send({ name: "Mine now" }).expect(403);
    await helper.agent.delete(`/api/boards/${boardId}`).expect(403);
    await helper.agent.post(`/api/boards/${boardId}/members`).send({ email: "x@example.com" }).expect(403);

    // Leaving.
    await helper.agent.delete(`/api/boards/${boardId}/members/${helper.userId}`).expect(204);
    await helper.agent.get(`/api/boards/${boardId}`).expect(404);
  });

  it("sends a deleted board's screens back to pairing", async () => {
    const { owner, boardId } = await makeBoard();
    const screen = await pair(owner, boardId);
    await owner.agent.delete(`/api/boards/${boardId}`).expect(204);
    const state = await screen.agent.post("/api/screen/status").send({}).expect(200);
    expect(state.body.paired).toBe(false);
    expect((await owner.agent.get("/api/boards").expect(200)).body.boards).toEqual([]);
  });
});

describe("live updates", () => {
  it("pushes a screen its new state the moment a message is broadcast", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    const events: { event: string; data: any }[] = [];
    const unsubscribe = ctx.hub.subscribeScreen(s.id, (event, data) => events.push({ event, data }));

    const { body } = await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Live" }).expect(201);
    await owner.agent.post(`/api/boards/${boardId}/messages/${body.message.id}/broadcast`).send({ screenIds: [s.id] }).expect(200);
    expect(events.at(-1)).toMatchObject({ event: "state", data: { message: { text: "Live" } } });
    unsubscribe();
  });

  it("tells dashboards when a screen wakes", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    let changes = 0;
    const unsubscribe = ctx.hub.subscribeBoard(boardId, () => changes++);
    await s.agent.post("/api/screen/status").send({ awake: true }).expect(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(changes).toBe(1);
    // A heartbeat with nothing new tells nobody.
    await s.agent.post("/api/screen/status").send({ awake: true }).expect(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(changes).toBe(1);
    unsubscribe();
  });
});

describe("display modes", () => {
  it("stores how a message moves and tells the screen", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    const { body } = await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Still", display: "whole" }).expect(201);
    expect(body.message.display).toBe("whole");
    await owner.agent.patch(`/api/boards/${boardId}/screens/${s.id}`).send({ messageId: body.message.id }).expect(200);
    expect((await s.agent.post("/api/screen/status").send({}).expect(200)).body.message.display).toBe("whole");

    await owner.agent.patch(`/api/boards/${boardId}/messages/${body.message.id}`).send({ display: "vertical" }).expect(200);
    expect((await s.agent.post("/api/screen/status").send({}).expect(200)).body.message.display).toBe("vertical");

    await owner.agent.patch(`/api/boards/${boardId}/messages/${body.message.id}`).send({ display: "diagonal" }).expect(400);
    const plain = await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Default" }).expect(201);
    expect(plain.body.message.display).toBe("horizontal");
  });
});

describe("waking screens", () => {
  it("tells the dashboard a screen is waiting for a tap", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    await s.agent.post("/api/screen/status").send({ awake: false, visible: true, needsTap: true }).expect(200);
    let screen = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body.screens[0];
    expect(screen).toMatchObject({ status: "open", needsTap: true });
    await s.agent.post("/api/screen/status").send({ awake: true, visible: true }).expect(200);
    screen = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body.screens[0];
    expect(screen).toMatchObject({ status: "awake", needsTap: false });
  });
});

describe("calendars", () => {
  const FEED_URL = "https://calendar.google.com/calendar/ical/me/private-abc/basic.ics";
  const at = (iso: string) => new Date(iso).getTime();

  async function setUp() {
    ctx.feeds.set(FEED_URL, GOOGLE_FEED);
    ctx.clock.now = at("2026-10-15T09:00:00Z");
    const { owner, boardId } = await makeBoard();
    const door = await pair(owner, boardId, "Office door");
    const lobby = await pair(owner, boardId, "Lobby");
    const added = await owner.agent.post(`/api/boards/${boardId}/calendars`).send({ name: "My calendar", url: FEED_URL }).expect(201);
    return { owner, boardId, door, lobby, calendarId: added.body.calendar.id as string };
  }

  it("turns away an address that isn't a calendar", async () => {
    const { owner, boardId } = await makeBoard();
    ctx.feeds.set("https://example.com/page", "<html>nope</html>");
    const res = await owner.agent.post(`/api/boards/${boardId}/calendars`).send({ url: "https://example.com/page" }).expect(400);
    expect(res.body.error).toMatch(/isn't an iCalendar feed/);
    await owner.agent.post(`/api/boards/${boardId}/calendars`).send({ url: "http://insecure.example.com/a.ics" }).expect(400);
    expect((await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body.calendars).toEqual([]);
  });

  it("shows a message during a meeting with a call link, then goes back to what the screen showed", async () => {
    const { owner, boardId, door, lobby, calendarId } = await setUp();

    const board = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body;
    expect(board.calendars[0]).toMatchObject({ id: calendarId, name: "My calendar", error: null, source: "calendar.google.com/…/basic.ics" });
    expect(board.calendars[0].upcoming[0]).toMatchObject({ title: "Weekly sync (moved)" });
    expect(JSON.stringify(board.calendars)).not.toContain("private-abc");

    // The lobby normally shows a welcome; the door shows nothing.
    const welcome = await owner.agent.post(`/api/boards/${boardId}/messages`).send({ text: "Welcome" }).expect(201);
    await owner.agent.patch(`/api/boards/${boardId}/screens/${lobby.id}`).send({ messageId: welcome.body.message.id }).expect(200);
    const sign = await owner.agent
      .post(`/api/boards/${boardId}/messages`)
      .send({ text: "In a meeting", display: "whole", calendar: { enabled: true, calendarId, screenIds: [door.id] } })
      .expect(201);
    const signId = sign.body.message.id;

    const showing = async (s: { agent: ReturnType<typeof request.agent> }) =>
      (await s.agent.post("/api/screen/status").send({}).expect(200)).body.message?.text ?? null;

    // Before the meeting.
    await ctx.calendar.evaluateAll();
    expect(await showing(door)).toBeNull();

    // 14:15 Kampala: the moved weekly sync is on.
    ctx.clock.now = at("2026-10-15T11:15:00Z");
    await ctx.calendar.evaluateAll();
    expect(await showing(door)).toBe("In a meeting");
    expect(await showing(lobby)).toBe("Welcome"); // not one of its screens
    const during = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body;
    const signCard = during.messages.find((m: { id: string }) => m.id === signId);
    expect(signCard.meeting).toMatchObject({ title: "Weekly sync (moved)", screenIds: [door.id] });
    expect(signCard.calendar).toEqual({ enabled: true, calendarId, screenIds: [door.id] });
    expect(during.screens.find((s: { id: string }) => s.id === door.id).meeting).toMatchObject({ messageId: signId });

    // The meeting ends: back to black.
    ctx.clock.now = at("2026-10-15T12:00:01Z");
    await ctx.calendar.evaluateAll();
    expect(await showing(door)).toBeNull();

    // On all screens for the Zoom call at 16:00 UTC, then the lobby goes back to its welcome.
    await owner.agent.patch(`/api/boards/${boardId}/messages/${signId}`).send({ calendar: { screenIds: null } }).expect(200);
    ctx.clock.now = at("2026-10-15T16:10:00Z");
    await ctx.calendar.evaluateAll();
    expect(await showing(lobby)).toBe("In a meeting");
    ctx.clock.now = at("2026-10-15T16:31:00Z");
    await ctx.calendar.evaluateAll();
    expect(await showing(lobby)).toBe("Welcome");
  });

  it("stops following a calendar when it's removed", async () => {
    const { owner, boardId, door, calendarId } = await setUp();
    const sign = await owner.agent
      .post(`/api/boards/${boardId}/messages`)
      .send({ text: "In a meeting", calendar: { enabled: true, calendarId } })
      .expect(201);
    ctx.clock.now = at("2026-10-15T11:15:00Z");
    await ctx.calendar.evaluateAll();
    expect((await door.agent.post("/api/screen/status").send({}).expect(200)).body.message.text).toBe("In a meeting");

    await owner.agent.delete(`/api/boards/${boardId}/calendars/${calendarId}`).expect(204);
    expect((await door.agent.post("/api/screen/status").send({}).expect(200)).body.message).toBeNull();
    const board = (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body;
    expect(board.messages.find((m: { id: string }) => m.id === sign.body.message.id).calendar.enabled).toBe(false);
  });

  it("only lets a message follow its own board's calendars", async () => {
    const { owner, boardId, calendarId } = await setUp();
    const other = await owner.agent.post("/api/boards").send({ name: "Other" }).expect(201);
    await owner.agent
      .post(`/api/boards/${other.body.board.id}/messages`)
      .send({ text: "x", calendar: { enabled: true, calendarId } })
      .expect(400);
    expect(boardId).toBeTruthy();
  });
});

describe("battery", () => {
  it("shows each screen's battery and flags the low ones", async () => {
    const { owner, boardId } = await makeBoard();
    const tablet = await pair(owner, boardId, "Tablet");
    const tv = await pair(owner, boardId, "TV");
    const iPad = await pair(owner, boardId, "iPad");
    const battery = async () => {
      const res = await owner.agent.get(`/api/boards/${boardId}`).expect(200);
      return Object.fromEntries(res.body.screens.map((s: { name: string; battery: unknown }) => [s.name, s.battery]));
    };

    // Before any report.
    expect(await battery()).toEqual({ Tablet: null, TV: null, iPad: null });

    await tablet.agent.post("/api/screen/status").send({ awake: true, battery: { level: 63.6, charging: false } }).expect(200);
    await tv.agent.post("/api/screen/status").send({ awake: true, battery: "none" }).expect(200);
    await iPad.agent.post("/api/screen/status").send({ awake: true, battery: "unavailable" }).expect(200);
    let now = await battery();
    expect(now.Tablet).toMatchObject({ level: 64, charging: false });
    expect(now.TV).toBe("none");
    expect(now.iPad).toBe("unavailable");

    const lowBattery = async () =>
      (await owner.agent.get("/api/boards").expect(200)).body.boards.find((b: { id: string }) => b.id === boardId).lowBattery;
    expect(await lowBattery()).toBe(0);

    await tablet.agent.post("/api/screen/status").send({ awake: true, battery: { level: 12, charging: false } }).expect(200);
    expect(await lowBattery()).toBe(1);
    // Charging, it's no longer a worry.
    await tablet.agent.post("/api/screen/status").send({ awake: true, battery: { level: 12, charging: true } }).expect(200);
    expect(await lowBattery()).toBe(0);

    // Nonsense, or a screen on an older build that doesn't report, leaves the last reading.
    await tablet.agent.post("/api/screen/status").send({ awake: true, battery: { level: 150, charging: false } }).expect(200);
    await tablet.agent.post("/api/screen/status").send({ awake: true }).expect(200);
    now = await battery();
    expect(now.Tablet).toMatchObject({ level: 12, charging: true });
  });

  it("tells dashboards when the battery changes", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    await s.agent.post("/api/screen/status").send({ awake: true, battery: { level: 80, charging: false } }).expect(200);
    await new Promise((r) => setTimeout(r, 80));
    let changes = 0;
    const unsubscribe = ctx.hub.subscribeBoard(boardId, () => changes++);
    await s.agent.post("/api/screen/status").send({ awake: true, battery: { level: 80, charging: false } }).expect(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(changes).toBe(0);
    await s.agent.post("/api/screen/status").send({ awake: true, battery: { level: 79, charging: false } }).expect(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(changes).toBe(1);
    unsubscribe();
  });
});

describe("a screen open more than once", () => {
  it("is awake if the copy on show is, whatever a copy in the background says", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    const status = async () => (await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body.screens[0].status;

    // The home-screen app, in front and awake…
    await s.agent.post("/api/screen/status").send({ client: "app", awake: true, visible: true }).expect(200);
    // …and a Safari tab with the same screen, in the background.
    await s.agent.post("/api/screen/status").send({ client: "tab", awake: false, visible: false }).expect(200);
    expect(await status()).toBe("awake");
    await s.agent.post("/api/screen/status").send({ client: "app", awake: true, visible: true }).expect(200);
    await s.agent.post("/api/screen/status").send({ client: "tab", awake: false, visible: false }).expect(200);
    expect(await status()).toBe("awake");

    // The app closes; the tab is still open.
    await s.agent.post("/api/screen/status").send({ client: "app", open: false }).expect(204);
    expect(await status()).toBe("open");

    // The tab's heartbeats stop too.
    ctx.clock.now += ONLINE_WINDOW_MS + 1000;
    expect(await status()).toBe("offline");
  });

  it("doesn't let a reloading page's goodbye take the new page offline", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    await s.agent.post("/api/screen/status").send({ client: "old", awake: true, visible: true }).expect(200);
    // The new page arrives before the old one's beacon.
    await s.agent.post("/api/screen/hello").send({ client: "new" }).expect(200);
    await s.agent.post("/api/screen/status").send({ client: "new", awake: true, visible: true }).expect(200);
    await s.agent.post("/api/screen/status").send({ client: "old", open: false }).expect(204);
    expect((await owner.agent.get(`/api/boards/${boardId}`).expect(200)).body.screens[0].status).toBe("awake");
  });

  it("doesn't tell dashboards anything when a copy repeats itself", async () => {
    const { owner, boardId } = await makeBoard();
    const s = await pair(owner, boardId);
    await s.agent.post("/api/screen/status").send({ client: "app", awake: true, visible: true }).expect(200);
    await new Promise((r) => setTimeout(r, 80));
    let changes = 0;
    const unsubscribe = ctx.hub.subscribeBoard(boardId, () => changes++);
    for (let i = 0; i < 3; i++) {
      await s.agent.post("/api/screen/status").send({ client: "app", awake: true, visible: true }).expect(200);
      await s.agent.post("/api/screen/status").send({ client: "tab", awake: false, visible: false }).expect(200);
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(changes).toBe(0);
    unsubscribe();
  });
});
