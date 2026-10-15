// Pure planning for `--trusted` input (docs/10, owner decisions 10-15; docs/07 §1.1).
//
// click --trusted: an interpolated pointer path that ends exactly on the target,
// then press, a random gap, release. Path: straight line from the last pointer
// position of the tab (or 0,0) to the target, minimum-jerk easing over a
// duration in [100, 400] ms, about 60 points per second (always >= 25/s, at
// least 3 points); optional perpendicular scatter of the intermediate points
// (off by default, never on the last point). Press gap in [50, 140] ms.
//
// type --trusted: one key event pair per character that has a key on the US
// layout, Input.insertText for the rest (CJK, emoji …), as measured for
// Playwright's keyboard.type() on the s46 probe page
// (fixtures/probe/oracle/*-type.json): no Shift key events for capitals
// (shiftKey:false, keyCode of the key), '中' only beforeinput / textInput /
// input. The key table is the US layout data of Playwright's
// usKeyboardLayout.ts (Apache-2.0, see NOTICE), printable keys only.
//
// Everything random comes from an injected rng, so the tests are deterministic;
// the CLI has no seed flag (owner decision D6).

/** Uniform in [0, 1). */
export type Rng = () => number;
export type Point = { x: number; y: number };
export type PathPoint = Point & { atMs: number };
export type ClickPlan = { from: Point; to: Point; points: PathPoint[]; durationMs: number; pressGapMs: number };

export const PATH_MS = { min: 100, max: 400 } as const;
export const PRESS_GAP_MS = { min: 50, max: 140 } as const;
export const POINTS_PER_SECOND = 60;
export const MIN_POINTS = 3;
/** Scatter used when a caller turns it on (owner decision D5: off by default). */
export const JITTER_PX = 0.4;

/** An rng value made safe: anything outside [0, 1) or not a number is clamped. */
function unit(rng: Rng): number {
  const v = rng();
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return v >= 1 ? 1 - Number.EPSILON : v;
}

/** Minimum-jerk position profile: 0 → 1 with zero velocity and acceleration at both ends. */
export function minJerk(tau: number): number {
  const t = Math.min(1, Math.max(0, tau));
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function planClick(from: Point, to: Point, rng: Rng, opts: { jitterPx?: number } = {}): ClickPlan {
  const durationMs = Math.round(PATH_MS.min + unit(rng) * (PATH_MS.max - PATH_MS.min));
  const n = Math.max(MIN_POINTS, Math.ceil((durationMs * POINTS_PER_SECOND) / 1000));
  const jitter = Math.max(0, Math.min(JITTER_PX, opts.jitterPx ?? 0));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  // Unit normal of the path (any direction for a zero-length path).
  const nx = len > 0 ? -dy / len : 1;
  const ny = len > 0 ? dx / len : 0;
  const points: PathPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const atMs = Math.round(((i * durationMs) / n) * 10) / 10;
    if (i === n) {
      points.push({ x: to.x, y: to.y, atMs: durationMs });
      continue;
    }
    const s = minJerk(i / n);
    const off = jitter > 0 ? (unit(rng) * 2 - 1) * jitter : 0;
    points.push({ x: r2(from.x + dx * s + nx * off), y: r2(from.y + dy * s + ny * off), atMs });
  }
  const pressGapMs = Math.round(PRESS_GAP_MS.min + unit(rng) * (PRESS_GAP_MS.max - PRESS_GAP_MS.min));
  return { from, to, points, durationMs, pressGapMs };
}

/** Distance of `p` from the infinite line through a and b (from `p` to a when a = b). */
export function distanceFromLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

// ---------------------------------------------------------------- typing

export type KeyStroke =
  | { kind: "key"; char: string; key: string; code: string; keyCode: number; text: string; location: number }
  | { kind: "insert"; char: string };

/** [code, keyCode, key, shifted key] — printable keys of the US layout (Playwright usKeyboardLayout.ts). */
const US_PRINTABLE: ReadonlyArray<readonly [string, number, string, string | null]> = [
  ["Backquote", 192, "`", "~"],
  ["Digit1", 49, "1", "!"],
  ["Digit2", 50, "2", "@"],
  ["Digit3", 51, "3", "#"],
  ["Digit4", 52, "4", "$"],
  ["Digit5", 53, "5", "%"],
  ["Digit6", 54, "6", "^"],
  ["Digit7", 55, "7", "&"],
  ["Digit8", 56, "8", "*"],
  ["Digit9", 57, "9", "("],
  ["Digit0", 48, "0", ")"],
  ["Minus", 189, "-", "_"],
  ["Equal", 187, "=", "+"],
  ["Backslash", 220, "\\", "|"],
  ["BracketLeft", 219, "[", "{"],
  ["BracketRight", 221, "]", "}"],
  ["Semicolon", 186, ";", ":"],
  ["Quote", 222, "'", '"'],
  ["Comma", 188, ",", "<"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
  ["Space", 32, " ", null],
  ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => [`Key${c}`, c.charCodeAt(0), c.toLowerCase(), c] as const),
];

const KEY_OF = new Map<string, { key: string; code: string; keyCode: number; text: string; location: number }>();
for (const [code, keyCode, key, shifted] of US_PRINTABLE) {
  KEY_OF.set(key, { key, code, keyCode, text: key, location: 0 });
  if (shifted !== null) KEY_OF.set(shifted, { key: shifted, code, keyCode, text: shifted, location: 0 });
}
// Playwright aliases "\n" and "\r" to Enter, whose text is "\r".
for (const nl of ["\n", "\r"]) KEY_OF.set(nl, { key: "Enter", code: "Enter", keyCode: 13, text: "\r", location: 0 });

/** One stroke per code point: a key when the US layout has one, else insertText. */
export function planTyping(text: string): KeyStroke[] {
  const out: KeyStroke[] = [];
  for (const char of text) {
    const k = KEY_OF.get(char);
    out.push(k === undefined ? { kind: "insert", char } : { kind: "key", char, ...k });
  }
  return out;
}

/** CDP Input.dispatchKeyEvent params for one key stroke (keyDown with text, then keyUp), as Playwright sends them. */
export function keyEventParams(k: Extract<KeyStroke, { kind: "key" }>): { down: Record<string, unknown>; up: Record<string, unknown> } {
  const base = { modifiers: 0, windowsVirtualKeyCode: k.keyCode, code: k.code, key: k.key, location: k.location, isKeypad: false };
  return {
    down: { type: "keyDown", ...base, text: k.text, unmodifiedText: k.text, autoRepeat: false },
    up: { type: "keyUp", ...base },
  };
}
