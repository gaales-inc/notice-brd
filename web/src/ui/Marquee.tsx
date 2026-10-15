import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { SIZE_VMIN, SPEED_CHARS_PER_SECOND } from "../../../shared/style";
import type { ScreenMessage } from "../screenClient";

type Style = Pick<ScreenMessage, "text" | "color" | "speed" | "size">;

/**
 * A message running right to left across its box, over and over.
 *
 * The strip is the text with a box-width of empty space in front of it, and
 * one CSS animation slides it by its own full width: the text enters at the
 * right edge and leaves at the left, then starts again. Only `transform`
 * changes, so the browser moves a finished layer and repaints nothing — kind
 * to a battery. Text height is a share of the box's shorter side, as on the
 * screen itself, so the dashboard's preview is the screen in miniature.
 */
export function Marquee({ message, class: className = "" }: { message: Style; class?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ font: number; duration: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const b = box.current;
      const s = strip.current;
      if (!b || !s) return;
      const short = Math.min(b.clientWidth, b.clientHeight);
      if (!short) return;
      const font = Math.max(10, Math.round((short * SIZE_VMIN[message.size as keyof typeof SIZE_VMIN]) / 100));
      s.style.fontSize = `${font}px`;
      const textWidth = Math.max(1, s.scrollWidth - b.clientWidth);
      const charWidth = textWidth / Math.max(1, [...message.text].length);
      const pxPerSecond = SPEED_CHARS_PER_SECOND[message.speed as keyof typeof SPEED_CHARS_PER_SECOND] * charWidth;
      const duration = (b.clientWidth + textWidth) / pxPerSecond;
      setLayout((prev) =>
        prev && prev.font === font && Math.abs(prev.duration - duration) < 0.05 ? prev : { font, duration }
      );
    };
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
  }, [message.text, message.size, message.speed]);

  return (
    <div class={`marquee ${className}`} ref={box}>
      <div
        // A new message starts from the right edge rather than mid-run.
        key={`${message.text}|${message.size}|${message.speed}`}
        ref={strip}
        class={`marquee-strip${layout ? " running" : ""}`}
        style={{
          color: message.color,
          fontSize: layout ? `${layout.font}px` : undefined,
          animationDuration: layout ? `${layout.duration.toFixed(2)}s` : undefined,
        }}
      >
        {message.text}
      </div>
    </div>
  );
}
