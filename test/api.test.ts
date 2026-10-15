import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ONLINE_WINDOW_MS } from "../server/hub";
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
