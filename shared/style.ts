/**
 * How a message looks on a screen. Shared by the API, which validates against
 * it, and the web app, which draws with it — so the two can't disagree.
 */

export const COLORS = [
  { value: "#ffffff", label: "White" },
  { value: "#ffd60a", label: "Yellow" },
  { value: "#ff9f0a", label: "Amber" },
  { value: "#ff453a", label: "Red" },
  { value: "#30d158", label: "Green" },
  { value: "#64d2ff", label: "Blue" },
  { value: "#bf5af2", label: "Purple" },
] as const;

export const SPEEDS = ["slow", "normal", "fast"] as const;
export const SIZES = ["small", "medium", "large"] as const;
/**
 * How a message moves: across the screen right to left, up it like credits,
 * or not at all — the whole message at once, as large as fits.
 */
export const DISPLAYS = ["horizontal", "vertical", "whole"] as const;

export type Speed = (typeof SPEEDS)[number];
export type Size = (typeof SIZES)[number];
export type Display = (typeof DISPLAYS)[number];

export const DEFAULT_STYLE = { color: "#ffd60a", speed: "normal" as Speed, size: "medium" as Size, display: "horizontal" as Display };

/** At or below this, a screen that isn't charging is flagged in the dashboard. */
export const LOW_BATTERY_PERCENT = 20;

export const MAX_MESSAGE_LENGTH = 500;
export const MAX_BOARD_NAME = 60;
export const MAX_SCREEN_NAME = 40;

/**
 * Text height as a share of the screen's shorter side, so it reads the same in
 * either orientation. Scrolling across is one line, so it can be huge;
 * scrolling up wraps into lines, so it is smaller. All at once is as large as
 * fits, up to the across size.
 */
export const SIZE_VMIN: Record<Display, Record<Size, number>> = {
  horizontal: { small: 24, medium: 42, large: 62 },
  vertical: { small: 9, medium: 14, large: 22 },
  whole: { small: 24, medium: 42, large: 62 },
};

/**
 * Characters that pass a point each second. A ticker is read a few letters at
 * a time, so speed is set in letters rather than pixels: big text then moves
 * faster in pixels, and reads at the same pace.
 */
export const SPEED_CHARS_PER_SECOND: Record<Speed, number> = { slow: 3, normal: 4.5, fast: 7 };

/** Scrolling up, a short message still crosses the screen in at most this many seconds. */
export const VERTICAL_MAX_CROSSING_SECONDS: Record<Speed, number> = { slow: 16, normal: 11, fast: 7 };

export const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/.test(v);
export const isSpeed = (v: unknown): v is Speed => (SPEEDS as readonly unknown[]).includes(v);
export const isSize = (v: unknown): v is Size => (SIZES as readonly unknown[]).includes(v);
export const isDisplay = (v: unknown): v is Display => (DISPLAYS as readonly unknown[]).includes(v);
