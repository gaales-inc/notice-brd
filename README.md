# notice-brd

NoticeBrd — a black screen with a message running across it, run from a dashboard. https://noticebrd.gaales.com

Any browser can be a screen: a TV, an old tablet by the door, a phone in a shop window. Open `/screen` on it and it shows a six-character code; enter the code in the dashboard and the screen is on your board. From then on the dashboard decides what it shows.

- **The screen** is black, always. A message broadcast to it shows in one of three ways, chosen per message: **scrolling across** right to left, **scrolling up** like credits, or **all at once**, centred and as large as fits. Each has its colour and size; the scrolls have a speed. With nothing broadcasting it is completely black — no clock, no logo — so an OLED panel lights no pixels. Either way the screen is kept awake. A tap shows, for a few seconds, which board and screen it is, whether it's connected and kept awake, and buttons for full screen, installing, the dashboard and unpairing.
- **The dashboard** (`/dashboard`) needs a verification code sent to the board owner's or a collaborator's email — no passwords. It holds a board's messages, its screens and its people. Broadcasting a message picks the screens it goes to; each screen shows one message at a time, so broadcasting on a screen replaces whatever it showed. A message on air shows which screens it is on, each with its live status, and every screen shows whether it is **Awake** (board open, screen kept on), **Open, may sleep** (board open, but the device can still turn its screen off), or **Offline** (with when it was last seen). Battery-powered screens show their **battery level** too — red at 20% or below when not charging, green with a bolt while charging, faded when it's the last reading from a screen gone offline — and the board warns when an open screen runs low. All of it updates live.
- **Calendars.** A board can follow calendar feeds (Google, Outlook / Microsoft 365, iCloud — their private iCal address). A message set to *show during meetings* goes on its screens by itself while a meeting with a call link (Meet, Zoom, Teams, Webex, Whereby, Jitsi, FaceTime, Chime, GoTo, BlueJeans, Skype, Slack huddles, RingCentral) is on, and comes off when the meeting ends; each screen then goes back to whatever it was showing. "In a meeting" on an office door, say.
- **People.** The board's owner adds collaborators by email; they're emailed, and sign in with a code like anyone else. Collaborators can write and broadcast messages and add, rename and remove screens; only the owner renames or deletes the board and chooses who's on it.
- **Installable**, as Gula is: "Install app" uses the browser's own install dialog where there is one (Chrome, Edge, Samsung Internet, Opera) and shows the steps for Safari and Firefox. The installed app opens full screen, and straight into whatever the device was last used as — so a screen that restarts lands back on its board without anyone touching it.

## How it works

One Node process (Express 5 + TypeScript + Postgres, the same stack as gula-api) serves the API, the event streams and the built web app (Vite + Preact). Same origin, so no CORS.

- **Screens need no account.** `POST /api/screen/hello` gives a browser a screen of its own — a random token in an HttpOnly cookie scoped to `/api/screen` — and, while it is unpaired, a code from an alphabet without 0/O or 1/I/L. Codes live 30 minutes and the screen fetches a new one before its old one runs out. A board member pairing it is what authorises it. Removing a screen from the board (or deleting the board) sends it back to showing a code.
- **Live updates** are Server-Sent Events. A screen holds `GET /api/screen/events` and is pushed a `state` event — board, screen name and the message to show — the moment anything that touches it changes. A dashboard holds `GET /api/boards/:id/events` and reloads the board when told `changed`. Both streams send a comment every 20 s, because Cloudflare drops a response that is silent for 100 s.
- **Presence is heartbeat-driven.** A screen posts `/api/screen/status` every 20 s and whenever something changes (wake lock taken or lost, tab hidden or shown), plus a beacon as the page closes. A screen counts as open only while its heartbeats are fresh (45 s): an open stream proves nothing, since a phone that drops off the network leaves its socket half-open for minutes. The heartbeat's answer is the screen's state, so a screen behind something that buffers event streams still catches up within 20 s. Presence lives in memory (`server/hub.ts`) — one container serves NoticeBrd — and rebuilds from the next round of heartbeats after a restart; `last_seen_at` is kept in the database.
- **Keeping the screen awake** (`web/src/wake.ts`): the Screen Wake Lock API where there is one (Chrome, Edge, Samsung Internet, Firefox 126+, Safari 16.4+; iOS home-screen apps from 18.4), taken again whenever it drops — the page coming back to the front, or the system releasing it. **Safari grants the first lock in a page only from a tap** (after that, the page can take it back by itself until it's reloaded), so an iPhone or iPad screen asks plainly — "Tap anywhere to keep this screen awake" — each time NoticeBrd is opened, and the dashboard shows it as **Needs a tap** until someone does. Where there's no working lock — older Safari and Firefox, iOS home-screen apps before 18.4 (which grant the lock and ignore it), or a lock refused even after a tap — a 2 KB silent video (`web/public/awake.mp4`/`.webm`) plays on a loop instead, started by that same tap. For an iPad or iPhone that's a permanent screen, also set Settings → Display & Brightness → Auto-Lock → Never; the screen's tap panel says so.
- **Battery** (`web/src/battery.ts`). Only Chromium browsers (Chrome, Edge, Samsung Internet, Opera) let a page read the battery, so an Android screen shows its level and an iPad or iPhone one says its browser doesn't share it. A computer without a battery reads as a full one on its charger — as does a fully charged laptop on its charger — so that reading counts as "no battery" only until the device has once read otherwise (remembered in `localStorage`); Android phones and tablets always count. The level rides on the heartbeat and every change of it, is stored on the screen (`battery_*` columns, so it survives a restart), and a change tells the board's dashboards.
- **Coming back from the background.** Phones and tablets freeze a page in the background and thaw it with its connections dead but not always closed. So whenever the screen returns to the front it starts over from `hello`; its event stream gets a `ping` every 20 s and is reopened after 50 s of silence; API calls give up after 15 s rather than hanging; and the service worker serves the cached app if the network hasn't answered a page load in 4 s. The installed app always opens on `/`, which is sent on to `/screen` or `/dashboard` before anything renders.
- **The ticker** (`web/src/ui/Marquee.tsx`) is the text with a box's worth of empty space before it, slid by its own length with one CSS animation — sideways for scrolling across, upwards (the text wrapped into lines) for scrolling up: only `transform` changes, so the browser moves a finished layer and repaints nothing. Text height is a share of the screen's shorter side (`shared/style.ts`) so it reads the same in either orientation, and speed is set in letters per second rather than pixels, so big text reads at the same pace (scrolling up, a short message still crosses the screen within a few seconds). All at once finds the largest size that fits without breaking a word. The dashboard's previews are the same component in a smaller box.
- **Meetings** (`server/calendar.ts`). Each feed is fetched every 3 minutes (`https` only, public hosts only, 15 MB at most) and parsed with ical.js: recurring meetings are expanded with their moved and cancelled occurrences, zones the feed defines or only names are both honoured, and all-day and cancelled events never count. The meetings from a day ago to three days ahead that have a call link in any field are cached on the calendar row, so every 15 s the server can work out which screens a meeting is putting a message on — on time, between fetches — without fetching. These overrides live in memory beside each screen's own message (`Live.overrides`), are pushed to screens like any other change, and are rebuilt within seconds of a restart. A feed that fails keeps its last meetings, so a sign doesn't drop off the door mid-meeting because a calendar blinked. The feed address is a secret: the dashboard only ever sees its host and file name.
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
| `GET` | `/boards` | — | | `{ boards: [{ id, name, role, screens, awake, open, onAir, lowBattery }] }` |
| `POST` | `/boards` | `{ name }` | | `201 { board }` — you're its owner |
| `GET` | `/boards/:id` | — | member | `{ board, role, me, members, messages, screens }` — messages carry `screenIds`, screens carry `status` and `lastSeenAt` |
| `GET` | `/boards/:id/events` | — | member | event stream: `changed` |
| `PATCH` | `/boards/:id` | `{ name }` | owner | |
| `DELETE` | `/boards/:id` | — | owner | `204`; its screens go back to pairing |
| `POST` | `/boards/:id/messages` | `{ text, color?, speed?, size?, display?, calendar? }` | member | `201 { message }` |
| `PATCH` | `/boards/:id/messages/:mid` | any of those | member | screens showing it redraw |
| `DELETE` | `/boards/:id/messages/:mid` | — | member | `204`; screens showing it go black |
| `POST` | `/boards/:id/messages/:mid/broadcast` | `{ screenIds }` | member | shows it on exactly these screens; others showing it go black |
| `POST` | `/boards/:id/messages/:mid/stop` | — | member | takes it off every screen |
| `POST` | `/boards/:id/screens` | `{ code, name? }` | member | `201 { screen }` — pairs the screen showing that code |
| `PATCH` | `/boards/:id/screens/:sid` | `{ name?, messageId? }` | member | `messageId: null` is the black screen |
| `DELETE` | `/boards/:id/screens/:sid` | — | member | `204`; the screen shows a new code |
| `POST` | `/boards/:id/calendars` | `{ name, url }` | member | `201 { calendar }` — fetched first; `400` with the reason if it isn't a calendar |
| `PATCH` | `/boards/:id/calendars/:cid` | `{ name }` | member | |
| `POST` | `/boards/:id/calendars/:cid/refresh` | — | member | `{ ok, error }` — fetches it now |
| `DELETE` | `/boards/:id/calendars/:cid` | — | member | `204`; messages that followed only it stop following |
| `POST` | `/boards/:id/members` | `{ email }` | owner | `201 { member, emailed }` — emails them |
| `DELETE` | `/boards/:id/members/:userId` | — | owner, or yourself | `204` |

Message text is one line of up to 500 characters (line breaks become spaces); `color` is one of the palette in `shared/style.ts`, `speed` is `slow`/`normal`/`fast`, `size` is `small`/`medium`/`large`, `display` is `horizontal`/`vertical`/`whole`. `calendar` is `{ enabled, calendarId, screenIds }`: show during meetings on that calendar (`null`: any of the board's) on those screens (`null`: all of them).

In the board, a message carries `screenIds` (where it was broadcast), `calendar`, and `meeting: { title, end, screenIds }` while a meeting has it on air; a screen carries `status`, `needsTap` (open, but waiting for a tap to stay awake), `meeting: { messageId, title, end }` and `battery` — `{ level, charging, at }`, `"none"`, `"unavailable"` or `null` (not reported yet); each calendar carries `source` (host and file name only), `fetchedAt`, `error`, `now` and the next three `upcoming` meetings.

### Screens (the `nb_screen` cookie)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/screen/hello` | `{ device }` | state; makes the screen and sets its cookie if it's new |
| `GET` | `/screen/events` | — | event stream: `state` |
| `POST` | `/screen/status` | `{ awake, visible, needsTap, battery }` or `{ open: false }` | state (`204` for the closing beacon); `battery` is `{ level: 0–100, charging }`, `"none"` or `"unavailable"`, and leaving it out keeps the last reading |
| `POST` | `/screen/unpair` | — | state |

State is `{ version, screen: { id, name }, paired, pairCode, pairExpiresAt, board: { name }, message: { id, text, color, speed, size, display } | null }` — the message a meeting has put on the screen, if any, else its own. The event stream also sends `ping` every 20 s.

## Development

```bash
npm install
npm test           # API (on an in-process Postgres, PGlite), calendar parsing, battery and device detection
npm run typecheck
```

To run it locally without a Postgres server, keep the database in a folder with PGlite and log sign-in codes instead of mailing them:

```bash
cp .env.example .env   # then set PGLITE_DIR=.data and MAILR_DEV_CONSOLE=1
npm run dev            # API on :3000, the web app with hot reload on http://localhost:5173
```

Or build and serve it the way production does: `npm run build && PGLITE_DIR=.data MAILR_DEV_CONSOLE=1 WEB_DIR=dist/web node dist/server/server/index.js`. The schema is created on startup (`server/schema.ts`), idempotently.

## Deployment

Pushes to `main` run the typecheck, tests and build, then join Tailscale and run `~/deploy.sh noticebrd` on sps-hack-station, which pulls `~/apps/notice-brd`, rebuilds the `noticebrd` compose service and checks `https://noticebrd.gaales.com/health`.

On the server:

- `~/docker-compose.yml` — the `noticebrd` service, built from `./apps/notice-brd`, no published ports, with a `noticebrd` database (and role) in the shared `db` Postgres and mailr on the compose network. `~/.env` holds `NOTICEBRD_DB_PASSWORD`; `MAILR_API_KEY` is shared.
- `~/.cloudflared/config.yml` — `noticebrd.gaales.com` → `http://noticebrd:3000`. Restart `cloudflared` after changing it.

Mail goes through mailr with `"brand": "noticebrd"` — NoticeBrd's own design once [gaales-inc/mailr#1](https://github.com/gaales-inc/mailr/pull/1) is deployed, the Gaales one until then.

Repository secrets used by the workflow: `DEPLOY_HOST`, `DEPLOY_USER`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` (the same values as gula-api). Without them the deploy job is skipped with a notice.
