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

export type Speed = (typeof SPEEDS)[number];
export type Size = (typeof SIZES)[number];

export const DEFAULT_STYLE = { color: "#ffd60a", speed: "normal" as Speed, size: "medium" as Size };

export const MAX_MESSAGE_LENGTH = 500;
export const MAX_BOARD_NAME = 60;
export const MAX_SCREEN_NAME = 40;

/** Text height as a share of the screen's shorter side, so it reads the same in either orientation. */
export const SIZE_VMIN: Record<Size, number> = { small: 24, medium: 42, large: 62 };

/**
 * Characters that pass a point each second. A ticker is read a few letters at
 * a time, so speed is set in letters rather than pixels: big text then moves
 * faster in pixels, and reads at the same pace.
 */
export const SPEED_CHARS_PER_SECOND: Record<Speed, number> = { slow: 3, normal: 4.5, fast: 7 };

export const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/.test(v);
export const isSpeed = (v: unknown): v is Speed => (SPEEDS as readonly unknown[]).includes(v);
export const isSize = (v: unknown): v is Size => (SIZES as readonly unknown[]).includes(v);
