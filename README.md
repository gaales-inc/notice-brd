# notice-brd

NoticeBrd — a black screen with a message running across it, run from a dashboard. https://noticebrd.gaales.com

Any browser can be a screen: a TV, an old tablet by the door, a phone in a shop window. Open `/screen` on it and it shows a six-character code; enter the code in the dashboard and the screen is on your board. From then on the dashboard decides what it shows.

- **The screen** is black, always. A message broadcast to it runs right to left across it, over and over, in the colour, speed and size it was written with. With nothing broadcasting it is completely black — no clock, no logo — so an OLED panel lights no pixels. Either way the screen is kept awake. A tap shows, for a few seconds, which board and screen it is, whether it's connected and kept awake, and buttons for full screen, installing, the dashboard and unpairing.
- **The dashboard** (`/dashboard`) needs a verification code sent to the board owner's or a collaborator's email — no passwords. It holds a board's messages, its screens and its people. Broadcasting a message picks the screens it goes to; each screen shows one message at a time, so broadcasting on a screen replaces whatever it showed. A message on air shows which screens it is on, each with its live status, and every screen shows whether it is **Awake** (board open, screen kept on), **Open, may sleep** (board open, but the device can still turn its screen off), or **Offline** (with when it was last seen). All of it updates live.
- **People.** The board's owner adds collaborators by email; they're emailed, and sign in with a code like anyone else. Collaborators can write and broadcast messages and add, rename and remove screens; only the owner renames or deletes the board and chooses who's on it.
- **Installable**: "Install app" uses the browser's own install dialog where there is one (Chrome, Edge, Samsung Internet, Opera) and shows the steps for Safari and Firefox. The installed app opens full screen, and straight into whatever the device was last used as — so a screen that restarts lands back on its board without anyone touching it.

## How it works

One Node process (Express 5 + TypeScript + Postgres) serves the API, the event streams and the built web app (Vite + Preact). Same origin, so no CORS.

- **Screens need no account.** `POST /api/screen/hello` gives a browser a screen of its own — a random token in an HttpOnly cookie scoped to `/api/screen` — and, while it is unpaired, a code from an alphabet without 0/O or 1/I/L. Codes live 30 minutes and the screen fetches a new one before its old one runs out. A board member pairing it is what authorises it. Removing a screen from the board (or deleting the board) sends it back to showing a code.
- **Live updates** are Server-Sent Events. A screen holds `GET /api/screen/events` and is pushed a `state` event — board, screen name and the message to show — the moment anything that touches it changes. A dashboard holds `GET /api/boards/:id/events` and reloads the board when told `changed`. Both streams send a comment every 20 s, because Cloudflare drops a response that is silent for 100 s.
- **Presence is heartbeat-driven.** A screen posts `/api/screen/status` every 20 s and whenever something changes (wake lock taken or lost, tab hidden or shown), plus a beacon as the page closes. A screen counts as open only while its heartbeats are fresh (45 s): an open stream proves nothing, since a phone that drops off the network leaves its socket half-open for minutes. The heartbeat's answer is the screen's state, so a screen behind something that buffers event streams still catches up within 20 s. Presence lives in memory (`server/hub.ts`) — one container serves NoticeBrd — and rebuilds from the next round of heartbeats after a restart; `last_seen_at` is kept in the database.
- **Keeping the screen awake** (`web/src/wake.ts`): the Screen Wake Lock API where there is one (Chrome, Edge, Samsung Internet, Firefox 126+, Safari 16.4+), taken again each time the page comes back to the foreground. Where there isn't — older Safari and Firefox, and iOS home-screen apps before 18.4, which grant the lock and then ignore it — a 2 KB silent video (`web/public/awake.mp4`/`.webm`) plays on a loop instead, since a playing video keeps any phone awake. A video with sound may only start from a tap, so on those browsers the screen asks for one ("Tap the screen to keep it awake") and the dashboard shows it as "Open, may sleep" until it gets it.
- **The ticker** (`web/src/ui/Marquee.tsx`) is the text with a box-width of empty space before it, slid by its own width with one CSS animation: only `transform` changes, so the browser moves a finished layer and repaints nothing. Text height is a share of the screen's shorter side (`shared/style.ts`: small 24%, medium 42%, large 62%) so it reads the same in either orientation, and speed is set in letters per second rather than pixels, so big text reads at the same pace. The dashboard's previews are the same component in a smaller box.
- **Old devices.** Old tablets and TV browsers make good screens, so the build targets Safari 12 / Chrome 64, and the screen's CSS avoids `inset`, flex `gap` and container units.
- **Staying current.** A screen can run for weeks. The server reports its build in every `state`; a screen on an older build reloads (at most once every ten minutes). A service worker keeps the app shell, and the screen keeps its last state in `localStorage`, so a screen that reloads without a connection carries on showing its message.

## API

All endpoints are under `/api`; errors are `{ "error": "message" }`. Writes must come from this origin. The dashboard's session is the `nb_session` cookie, set by `auth/verify`.

### Sign-in

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/auth/code` | `{ email }` | `{ ok: true }` — emails a code, valid 10 minutes, 5 attempts |
| `POST` | `/auth/verify` | `{ email, code }` | `{ user }` and the session cookie; creates the account on first sign-in |
| `POST` | `/auth/logout` | — | `{ ok: true }` |
| `GET` | `/auth/me` | — | `{ user }`, or 401 |

### Boards (signed in)

| Method | Path | Body | Who | Response |
|---|---|---|---|---|
| `GET` | `/boards` | — | | `{ boards: [{ id, name, role, screens, awake, open, onAir }] }` |
| `POST` | `/boards` | `{ name }` | | `201 { board }` — you're its owner |
| `GET` | `/boards/:id` | — | member | `{ board, role, me, members, messages, screens }` — messages carry `screenIds`, screens carry `status` and `lastSeenAt` |
| `GET` | `/boards/:id/events` | — | member | event stream: `changed` |
| `PATCH` | `/boards/:id` | `{ name }` | owner | |
| `DELETE` | `/boards/:id` | — | owner | `204`; its screens go back to pairing |
| `POST` | `/boards/:id/messages` | `{ text, color?, speed?, size? }` | member | `201 { message }` |
| `PATCH` | `/boards/:id/messages/:mid` | any of those | member | screens showing it redraw |
| `DELETE` | `/boards/:id/messages/:mid` | — | member | `204`; screens showing it go black |
| `POST` | `/boards/:id/messages/:mid/broadcast` | `{ screenIds }` | member | shows it on exactly these screens; others showing it go black |
| `POST` | `/boards/:id/messages/:mid/stop` | — | member | takes it off every screen |
| `POST` | `/boards/:id/screens` | `{ code, name? }` | member | `201 { screen }` — pairs the screen showing that code |
| `PATCH` | `/boards/:id/screens/:sid` | `{ name?, messageId? }` | member | `messageId: null` is the black screen |
| `DELETE` | `/boards/:id/screens/:sid` | — | member | `204`; the screen shows a new code |
| `POST` | `/boards/:id/members` | `{ email }` | owner | `201 { member, emailed }` — emails them |
| `DELETE` | `/boards/:id/members/:userId` | — | owner, or yourself | `204` |

Message text is one line of up to 500 characters (line breaks become spaces); `color` is one of the palette in `shared/style.ts`, `speed` is `slow`/`normal`/`fast`, `size` is `small`/`medium`/`large`.

### Screens (the `nb_screen` cookie)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/screen/hello` | `{ device }` | state; makes the screen and sets its cookie if it's new |
| `GET` | `/screen/events` | — | event stream: `state` |
| `POST` | `/screen/status` | `{ awake, visible }` or `{ open: false }` | state (`204` for the closing beacon) |
| `POST` | `/screen/unpair` | — | state |

State is `{ version, screen: { id, name }, paired, pairCode, pairExpiresAt, board: { name }, message: { id, text, color, speed, size } | null }`.

## Development

```bash
npm install
npm test           # API (on an in-process Postgres, PGlite) and device detection
npm run typecheck
```

To run it locally without a Postgres server, keep the database in a folder with PGlite and log sign-in codes instead of mailing them:

```bash
cp .env.example .env   # then set PGLITE_DIR=.data and MAILR_DEV_CONSOLE=1
npm run dev            # API on :3000, the web app with hot reload on http://localhost:5173
```

Or build and serve it the way production does: `npm run build && PGLITE_DIR=.data MAILR_DEV_CONSOLE=1 WEB_DIR=dist/web node dist/server/server/index.js`. The schema is created on startup (`server/schema.ts`), idempotently.

## Deployment

`.github/workflows/deploy.yml` runs the typecheck, tests and build on every push and pull request. A push to `main` then deploys: the job connects to the server over SSH and runs its deploy script, which rebuilds the container and checks `/health`. The server's address and access come from repository secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`); without them the deploy job is skipped with a notice.

In production the app runs as a single container behind a reverse proxy that terminates TLS, with Postgres and the mail service alongside it. Configuration is by environment variable — see `.env.example`. Sign-in codes and invitations go out through a separate mail service (`MAILR_URL`, `MAILR_API_KEY`).
