import { useEffect, useRef, useState } from "preact/hooks";
import { detectPlatform } from "../device";
import { canFullscreen, enterFullscreen, exitFullscreen, fullscreenOnTap, isFullscreen, onFullscreenChange, windowIsFullscreen } from "../fullscreen";
import { refreshApp } from "../refresh";
import { navigate } from "../router";
import { Connection, ScreenState, cachedState, startScreen, unpairScreen } from "../screenClient";
import { setMode } from "../storage";
import {
  enterVideoFullscreen,
  exitVideoFullscreen,
  inVideoFullscreen,
  onVideoFullscreenChange,
  showOnVideo,
  startVideoScreen,
  stopVideoScreen,
  videoFullscreenAvailable,
} from "../videoScreen";
import { keepAwake, letSleep, nudge, onWakeChange, WakeState, wakeState } from "../wake";
import { Icon, InstallButton, Logo } from "./common";
import { Marquee } from "./Marquee";

function useWake(): WakeState {
  const [state, setState] = useState(wakeState);
  useEffect(() => onWakeChange(setState), []);
  return state;
}

/**
 * The board on a screen. Black, always: either a message running across it,
 * or nothing at all — no clock, no logo — so an OLED panel lights no pixels.
 * Either way the screen is kept awake.
 *
 * A tap takes it full screen, where the browser allows (see fullscreen.ts);
 * on iPhone and iPad as a video, the one way past the status bar there (see
 * videoScreen.ts). A tap also shows a Refresh button in the corner for three
 * seconds — a home-screen app has no other way to reload. Three quick taps
 * open the screen's panel: what it is, how it's doing, and its options. Taps land as clicks straight
 * away (`touch-action: manipulation`), so a triple tap isn't eaten by zoom.
 * A mouse pointer left still hides, as over a video.
 */

/** Taps further apart than this start counting again. */
const TAP_GAP_MS = 500;
const REFRESH_SHOWN_MS = 3_000;
const POINTER_HIDES_MS = 3_000;
const FULLSCREEN_HINT_MS = 8_000;
export function ScreenPage() {
  const [state, setState] = useState<ScreenState | null>(cachedState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [panel, setPanel] = useState(false);
  const [slow, setSlow] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [refreshShown, setRefreshShown] = useState(false);
  const [fullscreenHint, setFullscreenHint] = useState(false);
  const [pointerIdle, setPointerIdle] = useState(false);
  const [, setFullscreen] = useState(isFullscreen);
  /** iPhone and iPad: full screen is the video's. */
  const [useVideo] = useState(videoFullscreenAvailable);
  const [videoFull, setVideoFull] = useState(false);
  /** Someone swiped out of the video: taps are for the page until they choose Full screen again. */
  const leftVideo = useRef(false);
  const hideTimer = useRef<number>();
  const refreshTimer = useRef<number>();
  const taps = useRef({ count: 0, last: 0 });
  const wake = useWake();

  useEffect(() => {
    setMode("screen");
    document.documentElement.classList.add("on-screen");
    keepAwake();
    const stop = startScreen({ onState: setState, onConnection: setConnection, onUpdateReady: () => setUpdateReady(true) });
    const slowTimer = window.setTimeout(() => setSlow(true), 4000);

    const stopWatching = onFullscreenChange(() => setFullscreen(isFullscreen()));
    let stopVideoWatch = () => {};
    if (useVideo) {
      startVideoScreen();
      stopVideoWatch = onVideoFullscreenChange(() => {
        const on = inVideoFullscreen();
        if (!on) leftVideo.current = true;
        setVideoFull(on);
      });
    }
    // Say what a tap does (an iPhone or iPad waiting for its keep-awake tap says it in the tap prompt).
    let hintTimer: number | undefined;
    if (useVideo || fullscreenOnTap()) {
      setFullscreenHint(true);
      hintTimer = window.setTimeout(() => setFullscreenHint(false), FULLSCREEN_HINT_MS);
    }

    // A mouse only: a tap on a touch screen also reports a mouse move, and
    // changing the page in answer to it can make Safari drop the tap.
    let pointerTimer: number | undefined;
    const moveEvent = "PointerEvent" in window ? "pointermove" : "mousemove";
    const pointerMoved = (e: Event) => {
      if ((e as PointerEvent).pointerType && (e as PointerEvent).pointerType !== "mouse") return;
      setPointerIdle(false);
      window.clearTimeout(pointerTimer);
      pointerTimer = window.setTimeout(() => setPointerIdle(true), POINTER_HIDES_MS);
    };
    pointerTimer = window.setTimeout(() => setPointerIdle(true), POINTER_HIDES_MS);
    window.addEventListener(moveEvent, pointerMoved);

    return () => {
      stop();
      letSleep();
      stopWatching();
      stopVideoWatch();
      // Off to the dashboard: that's a page, not a screen.
      exitFullscreen(false);
      if (useVideo) stopVideoScreen();
      window.clearTimeout(slowTimer);
      window.clearTimeout(hintTimer);
      window.clearTimeout(pointerTimer);
      window.removeEventListener(moveEvent, pointerMoved);
      document.documentElement.classList.remove("on-screen");
    };
  }, []);

  useEffect(() => {
    document.title = state?.board ? `${state.board.name} · NoticeBrd` : "NoticeBrd screen";
  }, [state?.board?.name]);

  const message = state?.paired ? state.message : null;
  useEffect(() => {
    if (!useVideo) return;
    showOnVideo(message);
    // Unpaired: the pairing code is a page, so out of the video to show it.
    if (state && !state.paired) {
      exitVideoFullscreen();
      leftVideo.current = false;
    }
  }, [state]);

  const goVideoFullscreen = () => {
    leftVideo.current = false;
    hideRefresh();
    enterVideoFullscreen();
  };

  const showPanel = () => {
    setPanel(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPanel(false), 8000);
  };

  const hideRefresh = () => {
    window.clearTimeout(refreshTimer.current);
    setRefreshShown(false);
  };

  const onTap = () => {
    // The wake lock first: it is asked for there and then, while the tap still counts.
    nudge();
    setFullscreenHint(false);
    if (!useVideo) enterFullscreen();
    // On iPhone and iPad the first tap goes straight into the video. Taps
    // after someone has swiped out of it are for the page: Refresh and the
    // panel, and Full screen to go back in.
    else if (state?.paired && !leftVideo.current && !panel && enterVideoFullscreen()) return;
    if (panel) {
      // A tap outside the panel closes it.
      setPanel(false);
      window.clearTimeout(hideTimer.current);
      return;
    }
    const now = Date.now();
    const t = taps.current;
    t.count = now - t.last <= TAP_GAP_MS ? t.count + 1 : 1;
    t.last = now;
    if (t.count >= 3) {
      t.count = 0;
      hideRefresh();
      showPanel();
      return;
    }
    setRefreshShown(true);
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => setRefreshShown(false), REFRESH_SHOWN_MS);
  };

  useEffect(
    () => () => {
      window.clearTimeout(refreshTimer.current);
      window.clearTimeout(hideTimer.current);
    },
    []
  );

  const videoOffer = useVideo && !!state?.paired && !videoFull;

  return (
    <div class={`screen${panel ? " with-panel" : ""}${pointerIdle && !panel ? " pointer-idle" : ""}`} onClick={onTap}>
      {message && <Marquee message={message} class="marquee-full" />}
      {state && !state.paired && <Pairing state={state} />}
      {!state && slow && <p class="screen-note">{connection === "offline" ? "Can't reach NoticeBrd. Retrying…" : "Connecting…"}</p>}
      {wake.needsTap && !panel && (
        // The one thing a black screen shows: without this tap, it will sleep.
        // Over a message or a pairing code it sits in a band at the foot, clear of them.
        <div class={`tap-prompt${message || (state && !state.paired) ? " over-message" : ""}`}>
          {videoOffer && !leftVideo.current ? (
            <>
              <p>Tap anywhere to start</p>
              <p class="tap-why">The screen then goes full screen and stays awake. This browser asks for a tap each time NoticeBrd opens.</p>
            </>
          ) : (
            <>
              <p>Tap anywhere to keep this screen awake</p>
              <p class="tap-why">This browser asks for a tap each time NoticeBrd opens.</p>
            </>
          )}
        </div>
      )}
      {fullscreenHint && !wake.needsTap && !panel && (useVideo ? videoOffer : true) && (
        <p class="fullscreen-hint">Tap anywhere for full screen</p>
      )}
      {refreshShown && !panel && (
        <div class="screen-corner">
          {videoOffer && (
            <button
              class="screen-refresh"
              onClick={(e) => {
                e.stopPropagation();
                goVideoFullscreen();
              }}
            >
              <Icon name="fullscreen" />
              <span>Full screen</span>
            </button>
          )}
          <button
            class="screen-refresh"
            onClick={(e) => {
              e.stopPropagation();
              void refreshApp();
            }}
          >
            <Icon name="refresh" />
            <span>Refresh</span>
          </button>
        </div>
      )}
      {panel && (
        <ScreenPanel
          state={state}
          connection={connection}
          wake={wake}
          updateReady={updateReady}
          onVideoFullscreen={videoOffer ? goVideoFullscreen : undefined}
          onKeep={showPanel}
          onUnpaired={(s) => {
            setState(s);
            setPanel(false);
          }}
        />
      )}
    </div>
  );
}

function Pairing({ state }: { state: ScreenState }) {
  const code = state.pairCode ?? "";
  return (
    <div class="pairing">
      <Logo />
      <h1>Show a board on this screen</h1>
      <div class="pair-code" aria-label={`Pair code ${code.split("").join(" ")}`}>
        <span>{code.slice(0, 3)}</span>
        <span>{code.slice(3)}</span>
      </div>
      <ol>
        <li>
          On your phone or computer, open <b>{location.host}/dashboard</b>
        </li>
        <li>
          Open a board and choose <b>Add screen</b>
        </li>
        <li>Enter the code above</li>
      </ol>
      <p class="faint">The code changes every 30 minutes. Tap three times for options.</p>
    </div>
  );
}

function ScreenPanel({
  state,
  connection,
  wake,
  updateReady,
  onVideoFullscreen,
  onKeep,
  onUnpaired,
}: {
  state: ScreenState | null;
  connection: Connection;
  wake: WakeState;
  updateReady: boolean;
  /** iPhone and iPad: full screen as a video. */
  onVideoFullscreen?: () => void;
  onKeep: () => void;
  onUnpaired: (s: ScreenState) => void;
}) {
  const [busy, setBusy] = useState(false);

  const unpair = async () => {
    if (!window.confirm("Take this screen off the board? It will show a new pair code.")) return;
    setBusy(true);
    try {
      onUnpaired(await unpairScreen());
    } catch {
      window.alert("Couldn't reach NoticeBrd. Try again.");
    } finally {
      setBusy(false);
    }
  };

  let wakeText = "Keeping the screen awake";
  if (!wake.active) {
    wakeText = wake.needsTap
      ? "Tap the screen to keep it awake"
      : "This browser can't keep the screen awake — turn off auto-lock in the device's settings";
  }
  const apple = detectPlatform() === "ios" || detectPlatform() === "mac-safari";

  return (
    <div
      class="screen-panel"
      onClick={(e) => {
        e.stopPropagation();
        onKeep();
      }}
    >
      <div class="screen-panel-head">
        <Logo />
        <span class={`pill ${connection === "live" ? "pill-ok" : "pill-warn"}`}>
          {connection === "live" ? "Connected" : connection === "offline" ? "Offline — retrying" : "Connecting…"}
        </span>
      </div>
      <dl class="facts">
        <dt>Board</dt>
        <dd>{state?.paired ? state.board?.name : "Not paired yet"}</dd>
        {state?.paired && (
          <>
            <dt>Screen</dt>
            <dd>{state.screen.name}</dd>
            <dt>Showing</dt>
            <dd>{state.message ? `“${state.message.text}”` : "Nothing — the screen stays black"}</dd>
          </>
        )}
        <dt>Awake</dt>
        <dd class={wake.active ? "ok" : "warn"}>{wakeText}</dd>
      </dl>
      {apple && (
        <p class="panel-tip">
          A screen that stays on all day: also set <b>Settings → Display &amp; Brightness → Auto-Lock</b> to <b>Never</b>. iPhone and iPad
          need one tap each time NoticeBrd is opened.
        </p>
      )}
      {updateReady && <p class="panel-tip">A newer NoticeBrd is ready. It loads the next time the app opens, or now with Update.</p>}
      <div class="screen-panel-actions">
        {onVideoFullscreen && (
          <button
            class="button"
            onClick={(e) => {
              e.stopPropagation();
              onVideoFullscreen();
            }}
          >
            <Icon name="fullscreen" />
            <span>Full screen</span>
          </button>
        )}
        {!onVideoFullscreen && canFullscreen() && (isFullscreen() || !windowIsFullscreen()) && (
          <button
            class="button"
            onClick={(e) => {
              e.stopPropagation();
              if (isFullscreen()) exitFullscreen(true);
              else enterFullscreen(true);
            }}
          >
            <Icon name="fullscreen" />
            <span>{isFullscreen() ? "Exit full screen" : "Full screen"}</span>
          </button>
        )}
        {updateReady && (
          <button
            class="button primary"
            onClick={(e) => {
              e.stopPropagation();
              window.location.reload();
            }}
          >
            <span>Update</span>
          </button>
        )}
        <button
          class="button"
          onClick={(e) => {
            e.stopPropagation();
            void refreshApp();
          }}
        >
          <Icon name="refresh" />
          <span>Refresh</span>
        </button>
        <InstallButton />
        <button
          class="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate("/dashboard");
          }}
        >
          <Icon name="dashboard" />
          <span>Dashboard</span>
        </button>
        {state?.paired && (
          <button class="button danger" disabled={busy} onClick={unpair}>
            <Icon name="unlink" />
            <span>Unpair</span>
          </button>
        )}
      </div>
    </div>
  );
}
