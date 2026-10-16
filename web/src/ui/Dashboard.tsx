import { useEffect, useRef, useState } from "preact/hooks";
import { MAX_BOARD_NAME } from "../../../shared/style";
import { api, ApiError } from "../api";
import { refreshApp } from "../refresh";
import { linkHandler, navigate } from "../router";
import { getMode, setMode } from "../storage";
import { BoardPage } from "./Board";
import { Icon, InstallButton, Logo, Modal, StatusDot, toast } from "./common";

export interface User {
  id: string;
  email: string;
}

interface BoardSummary {
  id: string;
  name: string;
  role: "owner" | "collaborator";
  screens: number;
  awake: number;
  open: number;
  onAir: number;
  lowBattery: number;
}

/** /dashboard and /dashboard/:boardId, behind the email code. */
export function Dashboard({ path }: { path: string }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const loadMe = () => {
    setError(null);
    api<{ user: User }>("GET", "/api/auth/me")
      .then((r) => setUser(r.user))
      .catch((err: ApiError) => (err.status === 401 ? setUser(null) : setError(err.message)));
  };

  useEffect(() => {
    // A screen that peeks at the dashboard stays a screen next time it opens.
    if (!getMode()) setMode("dashboard");
    loadMe();
  }, []);

  if (error)
    return (
      <div class="center-page">
        <p>{error}</p>
        <button class="button" onClick={loadMe}>
          Try again
        </button>
      </div>
    );
  if (user === undefined) return <div class="center-page faint">Loading…</div>;
  if (user === null) return <SignIn onSignedIn={setUser} />;

  const boardId = /^\/dashboard\/([^/]+)/.exec(path)?.[1];
  return (
    <div class="app">
      <Header user={user} onSignedOut={() => setUser(null)} />
      <main class="main">{boardId ? <BoardPage boardId={boardId} /> : <BoardList />}</main>
    </div>
  );
}

function Header({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  const signOut = async () => {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    onSignedOut();
  };

  return (
    <header class="topbar">
      <a href="/dashboard" class="topbar-home" onClick={linkHandler("/dashboard")}>
        <Logo />
      </a>
      <div class="topbar-actions">
      <button class="icon-button" aria-label="Refresh" title="Refresh" onClick={() => void refreshApp()}>
        <Icon name="refresh" />
      </button>
      <div class="menu" ref={menu}>
        <button class="icon-button" aria-label="Account menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="person" />
        </button>
        {open && (
          <div class="menu-list" role="menu">
            <div class="menu-email">{user.email}</div>
            <InstallButton class="menu-item" />
            <button
              class="menu-item"
              onClick={() => {
                setMode("screen");
                navigate("/screen");
              }}
            >
              <Icon name="screen" />
              <span>Use this device as a screen</span>
            </button>
            <button class="menu-item" onClick={signOut}>
              <Icon name="signout" />
              <span>Sign out</span>
            </button>
          </div>
        )}
      </div>
      </div>
    </header>
  );
}

// -------------------------------------------------------------------- sign-in

function SignIn({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async (e?: Event) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/auth/code", { email });
      setSentTo(email.trim().toLowerCase());
      setCode("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: User }>("POST", "/api/auth/verify", { email: sentTo, code });
      onSignedIn(r.user);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="auth">
      <div class="auth-card">
        <Logo />
        {!sentTo ? (
          <form onSubmit={sendCode}>
            <h1>Open the dashboard</h1>
            <p class="muted">Write messages and choose the screens they run across. We'll email you a verification code — no password needed.</p>
            <label class="field">
              <span>Email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                placeholder="you@example.com"
              />
            </label>
            {error && <p class="error">{error}</p>}
            <button class="button primary wide" disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <h1>Check your email</h1>
            <p class="muted">
              We sent a 6-digit code to <b>{sentTo}</b>. It works for 10 minutes.
            </p>
            <label class="field">
              <span>Verification code</span>
              <input
                class="code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                required
                autoFocus
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="123456"
              />
            </label>
            {error && <p class="error">{error}</p>}
            <button class="button primary wide" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Open dashboard"}
            </button>
            <div class="auth-alt">
              <button type="button" class="link" onClick={() => setSentTo(null)}>
                Use another email
              </button>
              <button type="button" class="link" disabled={busy} onClick={() => sendCode()}>
                Send a new code
              </button>
            </div>
          </form>
        )}
      </div>
      <p class="auth-foot">
        Setting up a display?{" "}
        <a
          href="/screen"
          onClick={(e) => {
            setMode("screen");
            linkHandler("/screen")(e);
          }}
        >
          Use this device as a screen
        </a>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- board list

function BoardList() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () =>
    api<{ boards: BoardSummary[] }>("GET", "/api/boards")
      .then((r) => {
        setBoards(r.boards);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    document.title = "Boards · NoticeBrd";
    void load();
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => window.clearInterval(t);
  }, []);

  if (!boards) return error ? <p class="error">{error}</p> : <p class="faint">Loading…</p>;

  return (
    <>
      <div class="page-head">
        <h1>Your boards</h1>
        {boards.length > 0 && (
          <button class="button primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            <span>New board</span>
          </button>
        )}
      </div>
      {boards.length === 0 ? (
        <div class="empty">
          <h2>Make your first board</h2>
          <p class="muted">
            A board is a set of screens — a lobby TV, a tablet by the door, a phone in a shop window — and the messages that run across them.
          </p>
          <NewBoardForm onCreated={(id) => navigate(`/dashboard/${id}`)} />
        </div>
      ) : (
        <div class="board-grid">
          {boards.map((b) => (
            <a key={b.id} href={`/dashboard/${b.id}`} class="board-card" onClick={linkHandler(`/dashboard/${b.id}`)}>
              <div class="board-card-head">
                <h2>{b.name}</h2>
                {b.role === "collaborator" && <span class="pill">Collaborator</span>}
              </div>
              <p class="board-card-stats">
                <span>
                  {b.screens} {b.screens === 1 ? "screen" : "screens"}
                </span>
                {b.screens > 0 && (
                  <span>
                    <StatusDot status={b.awake ? "awake" : b.open ? "open" : "offline"} /> {b.awake} awake
                  </span>
                )}
                <span class={b.onAir ? "on-air" : ""}>{b.onAir ? `${b.onAir} broadcasting` : "Nothing broadcasting"}</span>
                {b.lowBattery > 0 && <span class="battery-warn">{b.lowBattery} low on battery</span>}
              </p>
            </a>
          ))}
        </div>
      )}
      {creating && (
        <Modal title="New board" onClose={() => setCreating(false)}>
          <NewBoardForm onCreated={(id) => navigate(`/dashboard/${id}`)} />
        </Modal>
      )}
    </>
  );
}

function NewBoardForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ board: { id: string } }>("POST", "/api/boards", { name });
      onCreated(r.board.id);
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form class="inline-form" onSubmit={submit}>
      <label class="field grow">
        <span>Board name</span>
        <input
          value={name}
          maxLength={MAX_BOARD_NAME}
          required
          autoFocus
          placeholder="e.g. Reception"
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <button class="button primary" disabled={busy || !name.trim()}>
        Create board
      </button>
    </form>
  );
}
