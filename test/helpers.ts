import request from "supertest";
import { createApp } from "../server/app";
import { Db } from "../server/db";
import { Hub } from "../server/hub";
import { Mail } from "../server/mailr";
import { createPgliteDb } from "../server/pglite";
import { migrate } from "../server/schema";

export interface TestContext {
  app: ReturnType<typeof createApp>["app"];
  db: Db;
  hub: Hub;
  calendar: ReturnType<typeof createApp>["calendar"];
  mails: Mail[];
  clock: { now: number };
  /** Calendar feeds by address, served to the app instead of fetching them. */
  feeds: Map<string, string>;
}

/** The production SQL on an in-process Postgres: no server, no Docker. */
export async function createContext(): Promise<TestContext> {
  const db = await createPgliteDb();
  await migrate(db);
  const mails: Mail[] = [];
  const clock = { now: Date.now() };
  const hub = new Hub(() => clock.now);
  const feeds = new Map<string, string>();
  const { app, calendar } = createApp({
    db,
    hub,
    mailer: async (mail) => {
      mails.push(mail);
    },
    rateLimits: false,
    codeCooldownSeconds: 0,
    now: () => clock.now,
    fetchCalendar: async (url) => {
      const feed = feeds.get(url);
      if (feed === undefined) throw new Error("not found");
      return feed;
    },
  });
  return { app, db, hub, calendar, mails, clock, feeds };
}

export function codeFrom(mails: Mail[], email: string): string {
  const mail = [...mails].reverse().find((m) => m.to === email && m.blocks.some((b) => b.type === "code"));
  if (!mail) throw new Error(`No code sent to ${email}`);
  return (mail.blocks.find((b) => b.type === "code") as { text: string }).text;
}

/** A browser signed in to the dashboard: supertest's agent keeps the session cookie. */
export async function signIn(ctx: TestContext, email: string) {
  const agent = request.agent(ctx.app);
  await agent.post("/api/auth/code").send({ email }).expect(200);
  const res = await agent.post("/api/auth/verify").send({ email, code: codeFrom(ctx.mails, email) }).expect(200);
  return { agent, userId: res.body.user.id as string };
}

/** A browser opened on /screen. */
export async function openScreen(ctx: TestContext, device = "iPad · Safari") {
  const agent = request.agent(ctx.app);
  const res = await agent.post("/api/screen/hello").send({ device }).expect(200);
  return { agent, state: res.body };
}
