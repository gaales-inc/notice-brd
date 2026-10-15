import { useEffect, useRef, useState } from "preact/hooks";
import { COLORS, DEFAULT_STYLE, MAX_BOARD_NAME, MAX_MESSAGE_LENGTH, MAX_SCREEN_NAME, Size, Speed } from "../../../shared/style";
import { api, ApiError } from "../api";
import { linkHandler, navigate } from "../router";
import { Icon, Modal, ScreenStatus, STATUS_LABEL, StatusDot, timeAgo, toast, useTick } from "./common";
import { Marquee } from "./Marquee";

interface Message {
  id: string;
  text: string;
  color: string;
  speed: Speed;
  size: Size;
  createdAt: string;
  updatedAt: string;
  screenIds: string[];
}

interface Screen {
  id: string;
  name: string;
  device: string;
  messageId: string | null;
  pairedAt: string;
  status: ScreenStatus;
  lastSeenAt: string | null;
}

interface Member {
  userId: string;
  email: string;
  role: "owner" | "collaborator";
  pending: boolean;
}

interface BoardData {
  board: { id: string; name: string };
  role: "owner" | "collaborator";
  me: string;
  members: Member[];
  messages: Message[];
  screens: Screen[];
}

interface Draft {
  text: string;
  color: string;
  speed: Speed;
  size: Size;
}

/** Runs an API call, reports its error as a toast, and reloads the board either way. */
type Act = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

const SPEED_LABEL: Record<Speed, string> = { slow: "Slow", normal: "Normal", fast: "Fast" };
const SIZE_LABEL: Record<Size, string> = { small: "Small", medium: "Medium", large: "Large" };

/**
 * One board: its messages, its screens and its people. Kept live by the
 * board's event stream, which says "changed" whenever a screen wakes, sleeps,
 * closes or is told to show something new.
 */
export function BoardPage({ boardId }: { boardId: string }) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [broadcasting, setBroadcasting] = useState<Message | null>(null);
  const [addingScreen, setAddingScreen] = useState(false);
  useTick();

  const load = async () => {
    try {
      const d = await api<BoardData>("GET", `/api/boards/${boardId}`);
      setData(d);
      setError(null);
      document.title = `${d.board.name} · NoticeBrd`;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast("That board isn't available any more.");
        navigate("/dashboard", { replace: true });
      } else setError((err as Error).message);
    }
  };

  useEffect(() => {
    setData(null);
    void load();
    let events: EventSource | null = null;
    let reopen: number | undefined;
    let pending: number | undefined;
    const reload = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void load(), 120);
    };
    const open = () => {
      if (typeof EventSource === "undefined") return;
      const es = new EventSource(`/api/boards/${boardId}/events`);
      events = es;
      es.addEventListener("changed", reload);
      // After a dropped connection, catch up on whatever was missed.
      es.addEventListener("ready", reload);
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          window.clearTimeout(reopen);
          reopen = window.setTimeout(open, 5000);
        }
      };
    };
    open();
    // A backstop for networks that buffer event streams.
    const poll = window.setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      events?.close();
      window.clearTimeout(reopen);
      window.clearTimeout(pending);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [boardId]);

  const act: Act = async (fn, done) => {
    try {
      await fn();
      if (done) toast(done);
      return true;
    } catch (err) {
      toast((err as Error).message);
      return false;
    } finally {
      void load();
    }
  };

  if (!data) return error ? <p class="error">{error}</p> : <p class="faint">Loading…</p>;

  const awake = data.screens.filter((s) => s.status === "awake").length;
  const onAir = data.messages.filter((m) => m.screenIds.length).length;

  return (
    <>
      <a href="/dashboard" class="back" onClick={linkHandler("/dashboard")}>
        <Icon name="back" />
        <span>Boards</span>
      </a>
      <div class="page-head">
        <h1>{data.board.name}</h1>
        <BoardMenu data={data} act={act} />
      </div>
      <p class="summary">
        <span>
          <StatusDot status={awake ? "awake" : data.screens.some((s) => s.status === "open") ? "open" : "offline"} />{" "}
          {awake} of {data.screens.length} {data.screens.length === 1 ? "screen" : "screens"} awake
        </span>
        <span class={onAir ? "on-air" : ""}>
          {onAir ? `${onAir} ${onAir === 1 ? "message" : "messages"} broadcasting` : "Nothing broadcasting"}
        </span>
        {error && <span class="warn">Not updating: {error}</span>}
      </p>

      <div class="board-layout">
        <section class="col-main">
          <h2 class="section-title">Messages</h2>
          <Composer
            boardId={boardId}
            act={act}
            onBroadcast={(m) => setBroadcasting(m)}
          />
          {data.messages.length === 0 ? (
            <p class="faint empty-note">No messages yet. Write one above — it can say anything.</p>
          ) : (
            <ul class="message-list">
              {data.messages.map((m) => (
                <MessageCard key={m.id} boardId={boardId} message={m} screens={data.screens} act={act} onBroadcast={() => setBroadcasting(m)} />
              ))}
            </ul>
          )}
        </section>

        <aside class="col-side">
          <ScreensSection data={data} act={act} onAdd={() => setAddingScreen(true)} />
          <PeopleSection data={data} act={act} />
        </aside>
      </div>

      {broadcasting && (
        <BroadcastDialog
          boardId={boardId}
          // The live copy, so the screen list reflects what's on air right now.
          message={data.messages.find((m) => m.id === broadcasting.id) ?? broadcasting}
          screens={data.screens}
          messages={data.messages}
          act={act}
          onAddScreen={() => setAddingScreen(true)}
          onClose={() => setBroadcasting(null)}
        />
      )}
      {addingScreen && <AddScreenDialog boardId={boardId} act={act} onClose={() => setAddingScreen(false)} />}
    </>
  );
}

// ----------------------------------------------------------------- the board

function BoardMenu({ data, act }: { data: BoardData; act: Act }) {
  const [renaming, setRenaming] = useState(false);
  const boardUrl = `/api/boards/${data.board.id}`;

  if (data.role !== "owner") {
    const leave = async () => {
      if (!window.confirm(`Leave “${data.board.name}”? You won't see it until the owner adds you again.`)) return;
      if (await act(() => api("DELETE", `${boardUrl}/members/${data.me}`), `You left ${data.board.name}`)) navigate("/dashboard");
    };
    return (
      <button class="button subtle" onClick={leave}>
        Leave board
      </button>
    );
  }

  const remove = async () => {
    if (!window.confirm(`Delete “${data.board.name}” and its messages? Its screens go back to showing a pair code.`)) return;
    if (await act(() => api("DELETE", boardUrl), `Deleted ${data.board.name}`)) navigate("/dashboard");
  };

  return (
    <div class="row-actions">
      <button class="button subtle" onClick={() => setRenaming(true)}>
        <Icon name="edit" />
        <span>Rename</span>
      </button>
      <button class="button subtle danger" onClick={remove}>
        <Icon name="trash" />
        <span>Delete</span>
      </button>
      {renaming && (
        <NameDialog
          title="Rename board"
          label="Board name"
          initial={data.board.name}
          max={MAX_BOARD_NAME}
          onClose={() => setRenaming(false)}
          onSave={(name) => act(() => api("PATCH", boardUrl, { name }))}
        />
      )}
    </div>
  );
}

function NameDialog({
  title,
  label,
  initial,
  max,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  max: number;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          if (await onSave(name)) onClose();
          else setBusy(false);
        }}
      >
        <label class="field">
          <span>{label}</span>
          <input
            value={name}
            maxLength={max}
            required
            autoFocus
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="modal-actions">
          <button type="button" class="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button class="button primary" disabled={busy || !name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ messages

function StylePicker({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  return (
    <div class="style-picker">
      <div class="style-group" role="radiogroup" aria-label="Colour">
        {COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={draft.color === c.value}
            aria-label={c.label}
            title={c.label}
            class={`swatch${draft.color === c.value ? " selected" : ""}`}
            style={{ background: c.value }}
            onClick={() => onChange({ ...draft, color: c.value })}
          />
        ))}
      </div>
      <Segmented label="Speed" value={draft.speed} options={SPEED_LABEL} onChange={(speed) => onChange({ ...draft, speed })} />
      <Segmented label="Size" value={draft.size} options={SIZE_LABEL} onChange={(size) => onChange({ ...draft, size })} />
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {(Object.keys(options) as T[]).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} class={value === k ? "selected" : ""} onClick={() => onChange(k)}>
          {options[k]}
        </button>
      ))}
    </div>
  );
}

/** Writing a new message, or editing one (`message` given). */
function Composer({
  boardId,
  act,
  message,
  onBroadcast,
  onDone,
}: {
  boardId: string;
  act: Act;
  message?: Message;
  onBroadcast?: (m: Message) => void;
  onDone?: () => void;
}) {
  const blank: Draft = { text: "", ...DEFAULT_STYLE };
  const [draft, setDraft] = useState<Draft>(message ? { text: message.text, color: message.color, speed: message.speed, size: message.size } : blank);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(!!message);
  const expanded = focused || draft.text.length > 0;
  const text = draft.text.trim();

  const save = async (thenBroadcast: boolean) => {
    if (!text) return;
    setBusy(true);
    let created: Message | null = null;
    const ok = await act(async () => {
      if (message) {
        await api("PATCH", `/api/boards/${boardId}/messages/${message.id}`, { ...draft, text });
      } else {
        const r = await api<{ message: Omit<Message, "screenIds" | "createdAt" | "updatedAt"> }>("POST", `/api/boards/${boardId}/messages`, {
          ...draft,
          text,
        });
        created = { ...r.message, screenIds: [], createdAt: "", updatedAt: "" };
      }
    }, message ? (message.screenIds.length ? "Saved — the screens show the new version" : "Saved") : thenBroadcast ? undefined : "Message saved");
    setBusy(false);
    if (!ok) return;
    if (message) onDone?.();
    else {
      setDraft({ ...blank, color: draft.color, speed: draft.speed, size: draft.size });
      setFocused(false);
      if (thenBroadcast && created) onBroadcast?.(created);
    }
  };

  return (
    <form
      class={`composer${expanded ? " expanded" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save(!message);
      }}
    >
      <textarea
        rows={expanded ? 3 : 1}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder={message ? "" : "Write a new message…"}
        value={draft.text}
        autoFocus={!!message}
        onFocus={() => setFocused(true)}
        onInput={(e) => setDraft({ ...draft, text: (e.target as HTMLTextAreaElement).value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save(!message);
          }
        }}
      />
      {expanded && (
        <>
          <StylePicker draft={draft} onChange={setDraft} />
          <div class="preview" aria-label="Preview">
            <Marquee message={{ ...draft, text: text || "Your message runs across the screen like this" }} />
          </div>
          <div class="composer-foot">
            <span class="faint counter">
              {draft.text.length}/{MAX_MESSAGE_LENGTH}
            </span>
            {message ? (
              <>
                <button type="button" class="button subtle" onClick={onDone}>
                  Cancel
                </button>
                <button class="button primary" disabled={busy || !text}>
                  Save changes
                </button>
              </>
            ) : (
              <>
                <button type="button" class="button" disabled={busy || !text} onClick={() => void save(false)}>
                  Save for later
                </button>
                <button class="button primary" disabled={busy || !text}>
                  <Icon name="broadcast" />
                  <span>Broadcast…</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </form>
  );
}

function MessageCard({
  boardId,
  message,
  screens,
  act,
  onBroadcast,
}: {
  boardId: string;
  message: Message;
  screens: Screen[];
  act: Act;
  onBroadcast: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const url = `/api/boards/${boardId}/messages/${message.id}`;
  const on = screens.filter((s) => message.screenIds.includes(s.id));

  if (editing) {
    return (
      <li class="message-card editing">
        <Composer boardId={boardId} act={act} message={message} onDone={() => setEditing(false)} />
      </li>
    );
  }

  const remove = () => {
    const warning = on.length ? ` It's broadcasting on ${on.length === 1 ? "a screen, which" : `${on.length} screens, which`} will go black.` : "";
    if (window.confirm(`Delete this message?${warning}`)) void act(() => api("DELETE", url), "Message deleted");
  };

  return (
    <li class={`message-card${on.length ? " live" : ""}`}>
      <button class="message-led" style={{ color: message.color }} onClick={() => setPreviewing(!previewing)} title="Preview">
        {previewing ? <Marquee message={message} /> : <span class="message-text">{message.text}</span>}
      </button>
      <div class="message-meta">
        <span class="faint">
          {SPEED_LABEL[message.speed]} · {SIZE_LABEL[message.size]}
        </span>
      </div>
      {on.length > 0 ? (
        <div class="on-screens">
          <span class="on-air-badge">On air</span>
          <span class="on-screens-label">Broadcasting on</span>
          <ul class="chips">
            {on.map((s) => (
              <li key={s.id} class="chip" title={screenStatusText(s)}>
                <StatusDot status={s.status} />
                {s.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p class="faint off-air">Not broadcasting</p>
      )}
      <div class="row-actions">
        <button class={`button${on.length ? "" : " primary"}`} onClick={onBroadcast}>
          <Icon name="broadcast" />
          <span>{on.length ? "Change screens" : "Broadcast"}</span>
        </button>
        {on.length > 0 && (
          <button class="button" onClick={() => void act(() => api("POST", `${url}/stop`), "Stopped — those screens are black")}>
            <Icon name="stop" />
            <span>Stop</span>
          </button>
        )}
        <button class="icon-button" aria-label="Edit message" title="Edit" onClick={() => setEditing(true)}>
          <Icon name="edit" />
        </button>
        <button class="icon-button danger" aria-label="Delete message" title="Delete" onClick={remove}>
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

function screenStatusText(s: Screen): string {
  if (s.status === "awake") return "Awake — board open, screen kept on";
  if (s.status === "open") return "Board open, but the screen may sleep";
  return `Offline — last seen ${timeAgo(s.lastSeenAt)}`;
}

function BroadcastDialog({
  boardId,
  message,
  screens,
  messages,
  act,
  onAddScreen,
  onClose,
}: {
  boardId: string;
  message: Message;
  screens: Screen[];
  messages: Message[];
  act: Act;
  onAddScreen: () => void;
  onClose: () => void;
}) {
  const wasOn = message.screenIds.length > 0;
  const [chosen, setChosen] = useState<string[]>(() => (wasOn ? message.screenIds : screens.map((s) => s.id)));
  const [busy, setBusy] = useState(false);
  const allChosen = screens.length > 0 && screens.every((s) => chosen.includes(s.id));
  const toggle = (id: string) => setChosen(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const ids = chosen.filter((id) => screens.some((s) => s.id === id));
    const done = ids.length ? `Broadcasting on ${ids.length} ${ids.length === 1 ? "screen" : "screens"}` : "Stopped broadcasting";
    if (await act(() => api("POST", `/api/boards/${boardId}/messages/${message.id}/broadcast`, { screenIds: ids }), done)) onClose();
    else setBusy(false);
  };

  return (
    <Modal title="Broadcast message" onClose={onClose} wide>
      <div class="preview">
        <Marquee message={message} />
      </div>
      {screens.length === 0 ? (
        <div class="empty-inline">
          <p>This board has no screens yet. Open {location.host}/screen on the device you want to use, then add it here with the code it shows.</p>
          <div class="modal-actions">
            <button
              class="button primary"
              onClick={() => {
                onClose();
                onAddScreen();
              }}
            >
              <Icon name="plus" />
              <span>Add screen</span>
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div class="pick-head">
            <span>Show it on</span>
            <label class="check">
              <input type="checkbox" checked={allChosen} onChange={() => setChosen(allChosen ? [] : screens.map((s) => s.id))} />
              <span>All screens</span>
            </label>
          </div>
          <ul class="pick-list">
            {screens.map((s) => {
              const current = s.messageId && s.messageId !== message.id ? messages.find((m) => m.id === s.messageId) : null;
              return (
                <li key={s.id}>
                  <label class="check pick">
                    <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} />
                    <span class="pick-body">
                      <span class="pick-name">
                        <StatusDot status={s.status} /> {s.name}
                      </span>
                      <span class="faint pick-sub">
                        {STATUS_LABEL[s.status]}
                        {s.messageId === message.id ? " · showing this now" : current ? ` · replaces “${current.text}”` : " · black now"}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div class="modal-actions">
            <button type="button" class="button subtle" onClick={onClose}>
              Cancel
            </button>
            <button class={`button ${chosen.length || !wasOn ? "primary" : "danger"}`} disabled={busy || (!chosen.length && !wasOn)}>
              {chosen.length ? `Broadcast on ${chosen.length} ${chosen.length === 1 ? "screen" : "screens"}` : "Stop broadcasting"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------- screens

function ScreensSection({ data, act, onAdd }: { data: BoardData; act: Act; onAdd: () => void }) {
  return (
    <section class="panel">
      <div class="panel-head">
        <h2 class="section-title">Screens</h2>
        <button class="button" onClick={onAdd}>
          <Icon name="plus" />
          <span>Add screen</span>
        </button>
      </div>
      {data.screens.length === 0 ? (
        <p class="faint">
          No screens yet. Open <b>{location.host}/screen</b> on a TV, tablet or phone — it shows a code to add it here.
        </p>
      ) : (
        <ul class="screen-list">
          {data.screens.map((s) => (
            <ScreenRow key={s.id} boardId={data.board.id} screen={s} messages={data.messages} act={act} />
          ))}
        </ul>
      )}
      <p class="legend faint">
        <span>
          <StatusDot status="awake" /> Awake: board open, screen kept on
        </span>
        <span>
          <StatusDot status="open" /> Open, may sleep
        </span>
        <span>
          <StatusDot status="offline" /> Offline
        </span>
      </p>
    </section>
  );
}

function ScreenRow({ boardId, screen, messages, act }: { boardId: string; screen: Screen; messages: Message[]; act: Act }) {
  const [renaming, setRenaming] = useState(false);
  const url = `/api/boards/${boardId}/screens/${screen.id}`;
  const showing = messages.find((m) => m.id === screen.messageId);

  const remove = () => {
    if (window.confirm(`Remove “${screen.name}” from this board? It will show a pair code until it's added again.`))
      void act(() => api("DELETE", url), `Removed ${screen.name}`);
  };

  return (
    <li class={`screen-row status-${screen.status}`}>
      <div class="screen-row-head">
        <StatusDot status={screen.status} />
        <span class="screen-name">{screen.name}</span>
        <span class={`status-label status-${screen.status}`}>{STATUS_LABEL[screen.status]}</span>
      </div>
      <p class="faint screen-sub">
        {screen.device}
        {screen.status === "offline" && ` · last seen ${timeAgo(screen.lastSeenAt)}`}
      </p>
      <label class="field compact">
        <span>Showing</span>
        <select
          value={screen.messageId ?? ""}
          onChange={(e) => {
            const value = (e.target as HTMLSelectElement).value;
            void act(() => api("PATCH", url, { messageId: value || null }), value ? `Broadcasting on ${screen.name}` : `${screen.name} is black`);
          }}
        >
          <option value="">Nothing — black screen</option>
          {messages.map((m) => (
            <option key={m.id} value={m.id}>
              {m.text.length > 60 ? `${m.text.slice(0, 57)}…` : m.text}
            </option>
          ))}
        </select>
      </label>
      {showing && screen.status === "offline" && <p class="warn small">It will show when the screen comes back online.</p>}
      <div class="row-actions">
        <button class="button subtle" onClick={() => setRenaming(true)}>
          <Icon name="edit" />
          <span>Rename</span>
        </button>
        <button class="button subtle danger" onClick={remove}>
          <Icon name="trash" />
          <span>Remove</span>
        </button>
      </div>
      {renaming && (
        <NameDialog
          title="Rename screen"
          label="Screen name"
          initial={screen.name}
          max={MAX_SCREEN_NAME}
          onClose={() => setRenaming(false)}
          onSave={(name) => act(() => api("PATCH", url, { name }))}
        />
      )}
    </li>
  );
}

function AddScreenDialog({ boardId, act, onClose }: { boardId: string; act: Act; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const raw = code.replace(/[^A-Z0-9]/g, "");

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ screen: { name: string } }>("POST", `/api/boards/${boardId}/screens`, { code: raw, name: name.trim() });
      await act(async () => undefined, `${r.screen.name} added`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a screen" onClose={onClose}>
      <ol class="steps">
        <li>
          On the TV, tablet or phone you want to use, open <b>{location.host}/screen</b>.
        </li>
        <li>It shows a 6-character code. Type it here.</li>
      </ol>
      <form onSubmit={submit}>
        <label class="field">
          <span>Code on the screen</span>
          <input
            class="code-input"
            autoComplete="off"
            autoCapitalize="characters"
            spellcheck={false}
            required
            autoFocus
            maxLength={7}
            placeholder="ABC 123"
            value={code}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
              setCode(v.length > 3 ? `${v.slice(0, 3)} ${v.slice(3)}` : v);
            }}
          />
        </label>
        <label class="field">
          <span>Name (optional)</span>
          <input value={name} maxLength={MAX_SCREEN_NAME} placeholder="e.g. Lobby TV" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {error && <p class="error">{error}</p>}
        <div class="modal-actions">
          <button type="button" class="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button class="button primary" disabled={busy || raw.length !== 6}>
            Add screen
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------- people

function PeopleSection({ data, act }: { data: BoardData; act: Act }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const owner = data.role === "owner";
  const url = `/api/boards/${data.board.id}/members`;

  const add = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    let emailed = true;
    const ok = await act(async () => {
      const r = await api<{ emailed: boolean }>("POST", url, { email });
      emailed = r.emailed;
    });
    setBusy(false);
    if (ok) {
      toast(emailed ? `Added ${email.trim()} — we've emailed them` : `Added ${email.trim()}, but the invitation email didn't send`);
      setEmail("");
      input.current?.focus();
    }
  };

  return (
    <section class="panel">
      <div class="panel-head">
        <h2 class="section-title">People</h2>
      </div>
      <ul class="people">
        {data.members.map((m) => (
          <li key={m.userId}>
            <span class="person-email">{m.email}</span>
            <span class="pill">{m.role === "owner" ? "Owner" : m.pending ? "Invited" : "Collaborator"}</span>
            {owner && m.role !== "owner" && (
              <button
                class="icon-button danger"
                aria-label={`Remove ${m.email}`}
                title="Remove"
                onClick={() => window.confirm(`Remove ${m.email} from this board?`) && void act(() => api("DELETE", `${url}/${m.userId}`), `Removed ${m.email}`)}
              >
                <Icon name="close" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner ? (
        <form class="inline-form" onSubmit={add}>
          <label class="field grow">
            <span>Add a collaborator</span>
            <input
              ref={input}
              type="email"
              inputMode="email"
              placeholder="their@email.com"
              required
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            />
          </label>
          <button class="button" disabled={busy || !email.trim()}>
            Add
          </button>
        </form>
      ) : (
        <p class="faint small">Only the owner can add or remove people.</p>
      )}
      <p class="faint small">Everyone here signs in with a code sent to their email, and can write and broadcast messages.</p>
    </section>
  );
}
