import "dotenv/config";
import path from "path";
import { createApp } from "./app";
import { createPgDb, Db } from "./db";
import { Hub } from "./hub";
import { sendMail } from "./mailr";
import { migrate } from "./schema";

async function openDb(): Promise<Db> {
  // Local development without a Postgres server. Never set in production.
  if (process.env.PGLITE_DIR) {
    const { createPgliteDb } = await import("./pglite");
    return createPgliteDb(process.env.PGLITE_DIR);
  }
  return createPgDb();
}

async function main() {
  const db = await openDb();
  await migrate(db);

  const hub = new Hub();
  hub.start();

  // Unpaired screens nobody has opened in a month: a browser that looked once and left.
  const tidy = () =>
    db
      .query("DELETE FROM screens WHERE board_id IS NULL AND COALESCE(last_seen_at, created_at) < NOW() - INTERVAL '30 days'")
      .then(() => db.query("DELETE FROM sessions WHERE expires_at < NOW()"))
      .then(() => db.query("DELETE FROM login_codes WHERE expires_at < NOW() - INTERVAL '1 day'"))
      .catch((err) => console.error("Tidy-up failed:", err));
  void tidy();
  setInterval(tidy, 6 * 60 * 60_000).unref();

  // Built to dist/server/server/index.js, beside the web app in dist/web. In
  // development Vite serves the web app and this stays unset.
  const webDir = process.env.WEB_DIR || (process.env.NODE_ENV === "production" ? path.resolve(__dirname, "../../web") : undefined);
  const { app, live, calendar } = createApp({ db, mailer: sendMail, hub, webDir, appUrl: process.env.APP_URL });
  calendar.start();

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`NoticeBrd running on port ${port} (build ${live.version})`);
  });
  // Event streams are long-lived; let Node keep them rather than time them out.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;

  const shutdown = () => {
    hub.stop();
    calendar.stop();
    server.close();
    server.closeAllConnections();
    void db.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("NoticeBrd failed to start:", err);
  process.exit(1);
});
