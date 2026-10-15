import { useEffect } from "preact/hooks";
import { navigate } from "../router";
import { getMode, setMode } from "../storage";
import { Icon, InstallButton, Logo } from "./common";
import { Marquee } from "./Marquee";

/**
 * The front door. A device that has been used before goes straight back to
 * what it was — which is what the installed app opens — so a screen that
 * restarts lands on its board without anyone touching it.
 */
export function Home() {
  useEffect(() => {
    const mode = getMode();
    if (mode === "screen") navigate("/screen", { replace: true });
    else if (mode === "dashboard") navigate("/dashboard", { replace: true });
    else document.title = "NoticeBrd";
  }, []);

  if (getMode()) return null;

  return (
    <div class="home">
      <header class="home-head">
        <Logo />
        <InstallButton class="button subtle" />
      </header>
      <div class="home-hero">
        <Marquee message={{ text: "Say anything — on any screen, from anywhere", color: "#ffc53d", speed: "normal", size: "medium" }} />
      </div>
      <h1>A black screen with your message running across it.</h1>
      <p class="muted home-lede">
        Turn any TV, tablet or phone into a notice board. Write messages in the dashboard, choose which screens show them, and
        see which screens are awake. When nothing is on, the screen stays awake but completely black.
      </p>
      <div class="home-choices">
        <button
          class="choice"
          onClick={() => {
            setMode("dashboard");
            navigate("/dashboard");
          }}
        >
          <Icon name="dashboard" />
          <span class="choice-title">Open the dashboard</span>
          <span class="choice-text">Write messages and broadcast them. Sign in with a code sent to your email.</span>
        </button>
        <button
          class="choice"
          onClick={() => {
            setMode("screen");
            navigate("/screen");
          }}
        >
          <Icon name="screen" />
          <span class="choice-title">Use this device as a screen</span>
          <span class="choice-text">It shows a code to pair it with your board, then stays awake showing your messages.</span>
        </button>
      </div>
    </div>
  );
}
