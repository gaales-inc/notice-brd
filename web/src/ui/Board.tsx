import { useEffect, useRef, useState } from "preact/hooks";
import { COLORS, DEFAULT_STYLE, Display, MAX_BOARD_NAME, MAX_MESSAGE_LENGTH, MAX_SCREEN_NAME, Size, Speed } from "../../../shared/style";
import { api, ApiError } from "../api";
import { linkHandler, navigate } from "../router";
import { Icon, Modal, ScreenStatus, STATUS_LABEL, StatusDot, timeAgo, toast, useTick } from "./common";
import { Marquee } from "./Marquee";

interface CalendarSetting {
  enabled: boolean;
  /** null: any of the board's calendars. */
  calendarId: string | null;
  /** null: all the board's screens. */
  screenIds: string[] | null;
}

interface Message {
  id: string;
  text: string;
  color: string;
  speed: Speed;
  size: Size;
  display: Display;
  createdAt: string;
  updatedAt: string;
  /** Where it was broadcast. */
  screenIds: string[];
  calendar: CalendarSetting;
  /** Where a meeting has put it right now. */
  meeting: { title: string; end: string; screenIds: string[] } | null;
}

interface Screen {
  id: string;
  name: string;
  device: string;
  messageId: string | null;
  pairedAt: string;
  status: ScreenStatus;
  needsTap: boolean;
  lastSeenAt: string | null;
  meeting: { messageId: string; title: string; end: string } | null;
}

interface Member {
  userId: string;
  email: string;
  role: "owner" | "collaborator";
  pending: boolean;
}

interface Calendar {
  id: string;
  name: string;
  source: string;
  fetchedAt: string | null;
  error: string | null;
  now: { title: string; end: string } | null;
  upcoming: { title: string; start: string; end: string }[];
}

interface BoardData {
  board: { id: string; name: string };
  role: "owner" | "collaborator";
  me: string;
  members: Member[];
  messages: Message[];
  screens: Screen[];
  calendars: Calendar[];
}

interface Draft {
  text: string;
  color: string;
  speed: Speed;
  size: Size;
  display: Display;
  calendar: CalendarSetting;
}

/** Runs an API call, reports its error as a toast, and reloads the board either way. */
type Act = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

const SPEED_LABEL: Record<Speed, string> = { slow: "Slow", normal: "Normal", fast: "Fast" };
const SIZE_LABEL: Record<Size, string> = { small: "Small", medium: "Medium", large: "Large" };
const DISPLAY_LABEL: Record<Display, string> = { horizontal: "Scroll across", vertical: "Scroll up", whole: "All at once" };

const PLACEHOLDER: Record<Display, string> = {
  horizontal: "Your message runs across the screen like this",
  vertical: "Your message rolls up the screen like this, line after line, like the credits",
  whole: "Your whole message at once",
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};

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
  const onAir = data.messages.filter((m) => m.screenIds.length || m.meeting).length;

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
            screens={data.screens}
            calendars={data.calendars}
            onBroadcast={(m) => setBroadcasting(m)}
          />
          {data.messages.length === 0 ? (
            <p class="faint empty-note">No messages yet. Write one above — it can say anything.</p>
          ) : (
            <ul class="message-list">
              {data.messages.map((m) => (
                <MessageCard
                  key={m.id}
                  boardId={boardId}
                  message={m}
                  screens={data.screens}
                  calendars={data.calendars}
                  act={act}
                  onBroadcast={() => setBroadcasting(m)}
                />
              ))}
            </ul>
          )}
        </section>

        <aside class="col-side">
          <ScreensSection data={data} act={act} onAdd={() => setAddingScreen(true)} />
          <CalendarsSection data={data} act={act} />
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
      <Segmented label="Display" value={draft.display} options={DISPLAY_LABEL} onChange={(display) => onChange({ ...draft, display })} />
      {draft.display !== "whole" && (
        <Segmented label="Speed" value={draft.speed} options={SPEED_LABEL} onChange={(speed) => onChange({ ...draft, speed })} />
      )}
      <Segmented label="Size" value={draft.size} options={SIZE_LABEL} onChange={(size) => onChange({ ...draft, size })} />
    </div>
  );
}

/** "Show during meetings": which calendar's meetings, and on which screens. */
function CalendarPicker({
  value,
  onChange,
  screens,
  calendars,
}: {
  value: CalendarSetting;
  onChange: (v: CalendarSetting) => void;
  screens: Screen[];
  calendars: Calendar[];
}) {
  const none = calendars.length === 0;
  const chosen = value.screenIds ?? [];
  return (
    <div class="auto-cal">
      <label class={`check${none ? " disabled" : ""}`}>
        <input
          type="checkbox"
          checked={value.enabled && !none}
          disabled={none}
          onChange={(e) => onChange({ ...value, enabled: (e.target as HTMLInputElement).checked })}
        />
        <span>Show automatically during meetings with a call link</span>
      </label>
      {none && <p class="faint small auto-cal-note">Follow a calendar first — Calendars, on this board.</p>}
      {value.enabled && !none && (
        <div class="auto-cal-options">
          <label class="field compact">
            <span>Meetings on</span>
            <select
              value={value.calendarId ?? ""}
              onChange={(e) => onChange({ ...value, calendarId: (e.target as HTMLSelectElement).value || null })}
            >
              <option value="">{calendars.length === 1 ? calendars[0]!.name : "Any of the board's calendars"}</option>
              {calendars.length > 1 &&
                calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <div class="field compact">
            <span>Show it on</span>
            <label class="check">
              <input
                type="checkbox"
                checked={value.screenIds === null}
                onChange={(e) => onChange({ ...value, screenIds: (e.target as HTMLInputElement).checked ? null : screens.map((s) => s.id) })}
              />
              <span>All screens</span>
            </label>
            {value.screenIds !== null &&
              screens.map((s) => (
                <label class="check indent" key={s.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(s.id)}
                    onChange={() =>
                      onChange({ ...value, screenIds: chosen.includes(s.id) ? chosen.filter((id) => id !== s.id) : [...chosen, s.id] })
                    }
                  />
                  <span>{s.name}</span>
                </label>
              ))}
          </div>
          <p class="faint small auto-cal-note">
            It comes on when a meeting with a Meet, Zoom, Teams or other call link starts, and goes off when it ends — then each screen
            goes back to what it was showing.
          </p>
        </div>
      )}
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
  screens,
  calendars,
  onBroadcast,
  onDone,
}: {
  boardId: string;
  act: Act;
  message?: Message;
  screens: Screen[];
  calendars: Calendar[];
  onBroadcast?: (m: Message) => void;
  onDone?: () => void;
}) {
  const blank: Draft = { text: "", ...DEFAULT_STYLE, calendar: { enabled: false, calendarId: null, screenIds: null } };
  const [draft, setDraft] = useState<Draft>(
    message
      ? { text: message.text, color: message.color, speed: message.speed, size: message.size, display: message.display, calendar: message.calendar }
      : blank
  );
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
        const r = await api<{ message: Pick<Message, "id" | "text" | "color" | "speed" | "size" | "display"> }>(
          "POST",
          `/api/boards/${boardId}/messages`,
          { ...draft, text }
        );
        created = { ...r.message, screenIds: [], createdAt: "", updatedAt: "", calendar: draft.calendar, meeting: null };
      }
    }, message ? (message.screenIds.length ? "Saved — the screens show the new version" : "Saved") : thenBroadcast ? undefined : draft.calendar.enabled ? "Saved — it will show during meetings" : "Message saved");
    setBusy(false);
    if (!ok) return;
    if (message) onDone?.();
    else {
      setDraft({ ...blank, color: draft.color, speed: draft.speed, size: draft.size, display: draft.display });
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
            <Marquee message={{ ...draft, text: text || PLACEHOLDER[draft.display] }} />
          </div>
          <CalendarPicker value={draft.calendar} onChange={(calendar) => setDraft({ ...draft, calendar })} screens={screens} calendars={calendars} />
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
                  {draft.calendar.enabled ? "Save" : "Save for later"}
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
  calendars,
  act,
  onBroadcast,
}: {
  boardId: string;
  message: Message;
  screens: Screen[];
  calendars: Calendar[];
  act: Act;
  onBroadcast: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const url = `/api/boards/${boardId}/messages/${message.id}`;
  const on = screens.filter((s) => message.screenIds.includes(s.id));
  const duringMeeting = message.meeting ? screens.filter((s) => message.meeting!.screenIds.includes(s.id)) : [];
  const live = on.length > 0 || duringMeeting.length > 0;

  if (editing) {
    return (
      <li class="message-card editing">
        <Composer boardId={boardId} act={act} message={message} screens={screens} calendars={calendars} onDone={() => setEditing(false)} />
      </li>
    );
  }

  const remove = () => {
    const warning = on.length ? ` It's broadcasting on ${on.length === 1 ? "a screen, which" : `${on.length} screens, which`} will go black.` : "";
    if (window.confirm(`Delete this message?${warning}`)) void act(() => api("DELETE", url), "Message deleted");
  };

  const cal = message.calendar;
  const following = cal.enabled ? calendars.filter((c) => !cal.calendarId || c.id === cal.calendarId) : [];
  const next = following
    .flatMap((c) => c.upcoming)
    .sort((a, b) => a.start.localeCompare(b.start))[0];

  return (
    <li class={`message-card${live ? " live" : ""}`}>
      <button class="message-led" style={{ color: message.color }} onClick={() => setPreviewing(!previewing)} title="Preview">
        {previewing ? <Marquee message={message} /> : <span class="message-text">{message.text}</span>}
      </button>
      <div class="message-meta">
        <span class="faint">
          {DISPLAY_LABEL[message.display]}
          {message.display !== "whole" && ` · ${SPEED_LABEL[message.speed]}`} · {SIZE_LABEL[message.size]}
        </span>
        {cal.enabled && (
          <span class="cal-chip" title="Shows by itself during meetings with a call link">
            <Icon name="calendar" />
            During meetings
            {cal.calendarId && following[0] ? ` on ${following[0].name}` : ""}
            {cal.screenIds ? ` · ${cal.screenIds.length} ${cal.screenIds.length === 1 ? "screen" : "screens"}` : " · all screens"}
          </span>
        )}
      </div>
      {message.meeting && (
        <div class="on-screens">
          <span class="on-air-badge">On air</span>
          <span class="on-screens-label">
            During “{message.meeting.title}”, until {clock(message.meeting.end)}, on
          </span>
          <ScreenChips screens={duringMeeting} />
        </div>
      )}
      {on.length > 0 && (
        <div class="on-screens">
          {!message.meeting && <span class="on-air-badge">On air</span>}
          <span class="on-screens-label">Broadcasting on</span>
          <ScreenChips screens={on} />
        </div>
      )}
      {!live && (
        <p class="faint off-air">
          {cal.enabled
            ? next
              ? `Not on air. Next meeting: “${next.title}”, ${day(next.start)} ${clock(next.start)}`
              : "Not on air. It comes on during the next meeting with a call link."
            : "Not broadcasting"}
        </p>
      )}
      <div class="row-actions">
        <button class={`button${on.length || cal.enabled ? "" : " primary"}`} onClick={onBroadcast}>
          <Icon name="broadcast" />
          <span>{on.length ? "Change screens" : cal.enabled ? "Broadcast now" : "Broadcast"}</span>
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

function ScreenChips({ screens }: { screens: Screen[] }) {
  return (
    <ul class="chips">
      {screens.map((s) => (
        <li key={s.id} class="chip" title={screenStatusText(s)}>
          <StatusDot status={s.status} />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

function screenStatusText(s: Screen): string {
  if (s.status === "awake") return "Awake — board open, screen kept on";
  if (s.needsTap) return "Board open — tap the screen once to keep it awake";
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

  const meetingMessage = screen.meeting ? messages.find((m) => m.id === screen.meeting!.messageId) : null;

  return (
    <li class={`screen-row status-${screen.status}`}>
      <div class="screen-row-head">
        <StatusDot status={screen.status} />
        <span class="screen-name">{screen.name}</span>
        <span class={`status-label status-${screen.status}`}>{screen.needsTap ? "Needs a tap" : STATUS_LABEL[screen.status]}</span>
      </div>
      <p class="faint screen-sub">
        {screen.device}
        {screen.status === "offline" && ` · last seen ${timeAgo(screen.lastSeenAt)}`}
      </p>
      {screen.needsTap && (
        <p class="warn small screen-note-row">
          The board is open, but this browser only keeps the screen on after a tap. Tap the screen once — it asks for one each time
          NoticeBrd opens.
        </p>
      )}
      {screen.meeting && meetingMessage && (
        <p class="meeting-row small">
          <span class="on-air-badge">On air</span> “{meetingMessage.text.length > 40 ? `${meetingMessage.text.slice(0, 37)}…` : meetingMessage.text}”
          during “{screen.meeting.title}”, until {clock(screen.meeting.end)}
        </p>
      )}
      <label class="field compact">
        <span>{screen.meeting ? "Shows after the meeting" : "Showing"}</span>
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

// ----------------------------------------------------------------- calendars

function CalendarsSection({ data, act }: { data: BoardData; act: Act }) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Calendar | null>(null);
  const url = `/api/boards/${data.board.id}/calendars`;

  const refresh = (c: Calendar) =>
    act(async () => {
      const r = await api<{ ok: boolean; error: string | null }>("POST", `${url}/${c.id}/refresh`);
      if (r.error) throw new Error(r.error);
    }, `Checked ${c.name}`);

  const remove = (c: Calendar) => {
    const using = data.messages.filter((m) => m.calendar.enabled && m.calendar.calendarId === c.id).length;
    const warning = using ? ` ${using === 1 ? "A message that follows only it stops" : `${using} messages that follow only it stop`} showing during meetings.` : "";
    if (window.confirm(`Stop following “${c.name}”?${warning}`)) void act(() => api("DELETE", `${url}/${c.id}`), `Stopped following ${c.name}`);
  };

  return (
    <section class="panel">
      <div class="panel-head">
        <h2 class="section-title">Calendars</h2>
        <button class="button" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          <span>Add calendar</span>
        </button>
      </div>
      {data.calendars.length === 0 ? (
        <p class="faint">
          Follow a calendar to put a message up by itself during meetings with a call link — “In a meeting” on the office door, say — and
          take it down when the meeting ends.
        </p>
      ) : (
        <ul class="calendar-list">
          {data.calendars.map((c) => {
            const next = c.upcoming[0];
            return (
              <li key={c.id}>
                <div class="cal-head">
                  <Icon name="calendar" />
                  <span class="cal-name">{c.name}</span>
                </div>
                <p class="faint small cal-source">{c.source}</p>
                {c.error ? (
                  <p class="warn small">{c.error}</p>
                ) : c.now ? (
                  <p class="small on-air">
                    In “{c.now.title}” until {clock(c.now.end)}
                  </p>
                ) : next ? (
                  <p class="small muted">
                    Next: “{next.title}”, {day(next.start)} {clock(next.start)}
                  </p>
                ) : (
                  <p class="faint small">No meetings with a call link in the next three days.</p>
                )}
                <div class="row-actions">
                  <span class="faint small cal-checked">Checked {timeAgo(c.fetchedAt)}</span>
                  <button class="icon-button" aria-label={`Check ${c.name} now`} title="Check now" onClick={() => void refresh(c)}>
                    <Icon name="refresh" />
                  </button>
                  <button class="icon-button" aria-label={`Rename ${c.name}`} title="Rename" onClick={() => setRenaming(c)}>
                    <Icon name="edit" />
                  </button>
                  <button class="icon-button danger" aria-label={`Stop following ${c.name}`} title="Remove" onClick={() => remove(c)}>
                    <Icon name="trash" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <AddCalendarDialog boardId={data.board.id} act={act} onClose={() => setAdding(false)} />}
      {renaming && (
        <NameDialog
          title="Rename calendar"
          label="Calendar name"
          initial={renaming.name}
          max={MAX_BOARD_NAME}
          onClose={() => setRenaming(null)}
          onSave={(name) => act(() => api("PATCH", `${url}/${renaming.id}`, { name }))}
        />
      )}
    </section>
  );
}

function AddCalendarDialog({ boardId, act, onClose }: { boardId: string; act: Act; onClose: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/boards/${boardId}/calendars`, { name: name.trim() || "Calendar", url: url.trim() }, 45_000);
      await act(async () => undefined, `Following ${name.trim() || "the calendar"}`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Follow a calendar" onClose={onClose} wide>
      <p class="muted">
        Paste the calendar's private iCal (ICS) address. NoticeBrd checks it every few minutes for meetings with a Meet, Zoom, Teams or
        other call link. Nobody needs to sign in to the calendar, and the address only lets NoticeBrd read it.
      </p>
      <details class="how-to">
        <summary>Where to find the address</summary>
        <dl>
          <dt>Google Calendar</dt>
          <dd>
            On a computer: Settings → your calendar (under “Settings for my calendars”) → Integrate calendar → copy{" "}
            <b>Secret address in iCal format</b>.
          </dd>
          <dt>Outlook / Microsoft 365</dt>
          <dd>
            Settings → Calendar → Shared calendars → Publish a calendar → choose the calendar and <b>Can view all details</b> → Publish → copy
            the <b>ICS</b> link.
          </dd>
          <dt>iCloud (Apple Calendar)</dt>
          <dd>
            In Calendar, share the calendar → turn on <b>Public Calendar</b> → copy the link (it starts with webcal://).
          </dd>
        </dl>
      </details>
      <form onSubmit={submit}>
        <label class="field">
          <span>Calendar address</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellcheck={false}
            required
            autoFocus
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Name</span>
          <input value={name} maxLength={MAX_BOARD_NAME} placeholder="e.g. Sam's calendar" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <p class="faint small">Everyone on this board can see the titles of the meetings that put a message up.</p>
        {error && <p class="error">{error}</p>}
        <div class="modal-actions">
          <button type="button" class="button subtle" onClick={onClose}>
            Cancel
          </button>
          <button class="button primary" disabled={busy || !url.trim()}>
            {busy ? "Checking the calendar…" : "Follow calendar"}
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
