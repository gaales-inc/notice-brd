import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Display, SIZE_VMIN, SPEED_CHARS_PER_SECOND, VERTICAL_MAX_CROSSING_SECONDS } from "../../../shared/style";
import type { ScreenMessage } from "../screenClient";

type Style = Pick<ScreenMessage, "text" | "color" | "speed" | "size"> & { display?: Display };

/**
 * A message on a black box, in one of three ways: running right to left
 * across it, rolling up it like credits, or all of it at once, as large as
 * fits. Text height is a share of the box's shorter side, as on the screen
 * itself, so the dashboard's preview is the screen in miniature.
 *
 * Both scrolls are one CSS animation of `transform` on a strip that is the
 * text plus a box's worth of empty space before it, slid by its own length:
 * the text enters at one edge and leaves by the other, then starts again. The
 * browser moves a finished layer and repaints nothing — kind to a battery.
 */
export function Marquee({ message, class: className = "" }: { message: Style; class?: string }) {
  const display = message.display ?? "horizontal";
  if (display === "whole") return <Whole message={message} className={className} />;
  if (display === "vertical") return <Scroll message={message} className={className} vertical />;
  return <Scroll message={message} className={className} vertical={false} />;
}

/** Re-runs `measure` whenever the box changes size or fonts finish loading. */
function useMeasure(box: { current: HTMLElement | null }, measure: () => void, deps: unknown[]) {
  useLayoutEffect(() => {
    measure();
    const RO = (window as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const observer = RO ? new RO(measure) : null;
    if (observer && box.current) observer.observe(box.current);
    else window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    void (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, deps);
}

const fontFor = (box: HTMLElement, display: Display, size: string) =>
  Math.max(10, Math.round((Math.min(box.clientWidth, box.clientHeight) * SIZE_VMIN[display][size as "medium"]) / 100));

function Scroll({ message, className, vertical }: { message: Style; className: string; vertical: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ font: number; duration: number; lead: number } | null>(null);
  const chars = Math.max(1, [...message.text].length);
  const cps = SPEED_CHARS_PER_SECOND[message.speed as keyof typeof SPEED_CHARS_PER_SECOND];

  useMeasure(
    box,
    () => {
      const b = box.current;
      const s = strip.current;
      if (!b || !s || !b.clientWidth || !b.clientHeight) return;
      const font = fontFor(b, vertical ? "vertical" : "horizontal", message.size);
      s.style.fontSize = `${font}px`;
      let duration: number;
      let lead: number;
      if (vertical) {
        // The spacer is the box's height, so the text starts just below the bottom edge.
        lead = b.clientHeight;
        if (spacer.current) spacer.current.style.height = `${lead}px`;
        const textHeight = Math.max(1, s.offsetHeight - lead);
        // A line's worth of letters read at the chosen pace, but never so slow
        // that a one-liner takes all day to cross the screen.
        const byReading = (cps * textHeight) / chars;
        const byCrossing = lead / VERTICAL_MAX_CROSSING_SECONDS[message.speed as keyof typeof VERTICAL_MAX_CROSSING_SECONDS];
        duration = (lead + textHeight) / Math.max(byReading, byCrossing);
      } else {
        lead = b.clientWidth;
        const textWidth = Math.max(1, s.scrollWidth - lead);
        duration = (lead + textWidth) / ((cps * textWidth) / chars);
      }
      setLayout((prev) =>
        prev && prev.font === font && prev.lead === lead && Math.abs(prev.duration - duration) < 0.05 ? prev : { font, duration, lead }
      );
    },
    [message.text, message.size, message.speed, vertical]
  );

  return (
    <div class={`marquee ${vertical ? "marquee-v" : ""} ${className}`} ref={box}>
      <div
        // A new message starts from the edge rather than mid-run.
        key={`${message.text}|${message.size}|${message.speed}|${vertical}`}
        ref={strip}
        class={`${vertical ? "vscroll-strip" : "marquee-strip"}${layout ? " running" : ""}`}
        style={{
          color: message.color,
          fontSize: layout ? `${layout.font}px` : undefined,
          animationDuration: layout ? `${layout.duration.toFixed(2)}s` : undefined,
        }}
      >
        {vertical && <div ref={spacer} style={{ height: layout ? `${layout.lead}px` : "100vh" }} />}
        {message.text}
      </div>
    </div>
  );
}

/**
 * The whole message at once, centred, at the largest size that fits — up to
 * the chosen size — without breaking a word, unless a word is too long to fit
 * any other way.
 */
function Whole({ message, className }: { message: Style; className: string }) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [font, setFont] = useState<{ px: number; breakWords: boolean } | null>(null);

  useMeasure(
    box,
    () => {
      const b = box.current;
      const t = text.current;
      if (!b || !t || !b.clientWidth || !b.clientHeight) return;
      const style = getComputedStyle(b);
      const availW = b.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availH = b.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const fits = (px: number, breakWords: boolean) => {
        t.style.fontSize = `${px}px`;
        t.className = `whole-text${breakWords ? " break" : ""}`;
        return t.offsetHeight <= availH && t.scrollWidth <= Math.ceil(availW) + 1;
      };
      const cap = fontFor(b, "whole", message.size);
      const search = (breakWords: boolean) => {
        let lo = 6;
        let hi = cap;
        if (!fits(lo, breakWords)) return 0;
        for (let i = 0; i < 14 && hi - lo > 1; i++) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(mid, breakWords)) lo = mid;
          else hi = mid;
        }
        return fits(hi, breakWords) ? hi : lo;
      };
      let px = search(false);
      let breakWords = false;
      if (!px) {
        breakWords = true;
        px = search(true) || 6;
      }
      t.style.fontSize = `${px}px`;
      t.className = `whole-text${breakWords ? " break" : ""}`;
      setFont((prev) => (prev && prev.px === px && prev.breakWords === breakWords ? prev : { px, breakWords }));
    },
    [message.text, message.size]
  );

  return (
    <div class={`whole ${className}`} ref={box}>
      <div
        ref={text}
        class={`whole-text${font?.breakWords ? " break" : ""}`}
        style={{ color: message.color, fontSize: font ? `${font.px}px` : undefined, visibility: font ? "visible" : "hidden" }}
      >
        {message.text}
      </div>
    </div>
  );
}
