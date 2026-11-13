// `--os` input (docs/16): keys and pointer presses sent through the operating
// system's own input queue instead of CDP, for controls that read input below
// Chrome. The price is the foreground: the tabcap browser window must be the
// foreground window, and the real keyboard and pointer are used.
//
// Three rules hold everywhere in this file:
//   1. nothing is sent unless the foreground window belongs to tabcap's Chrome
//      and the page says it has focus; this is checked again before every key
//      and before the press, and a change stops the command at once
//      (`not-foreground`, with the number of keys already sent);
//   2. the pointer is pressed only where the page itself reported it to be
//      (closed loop over trusted `mousemove` events), never at a computed
//      screen position alone;
//   3. tabcap never retries and never takes the foreground by a trick: it asks
//      Chrome (Page.bringToFront), checks, and otherwise asks for the human.
//
// The system calls are behind OsInput (os/input.ts); the functions here take
// it as an argument, so the unit tests run them against a fake.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import {
  holdRecords,
  mouseRecord,
  moveRecord,
  MOUSEEVENTF,
  strokeRecords,
  toAbsolute,
  type Foreground,
  type OsInput,
  type OsStroke,
  type ScreenRect,
} from "../os/input.ts";
import { openWin32 } from "../os/win32.ts";
import type { Point, Rng } from "./inputplan.ts";
import { PRESS_GAP_MS } from "./inputplan.ts";

/** ms between two characters of `type --os` unless --delay says otherwise (docs/16 §9.3). */
export const OS_TYPE_DELAY_MS = 120;
/** How long a key stays down. */
export const OS_KEY_HOLD_MS = 40;
/** Between a modifier and the key it modifies, both ways. */
export const OS_MODIFIER_GAP_MS = 20;
/** How long Chrome has to become the foreground window after Page.bringToFront. */
export const FOREGROUND_WAIT_MS = 3000;
export const FOREGROUND_POLL_MS = 50;
/** The page's answer to "do you have focus" must come within this. */
export const FOCUS_ANSWER_MS = 2000;
/** How long the page has to report a pointer move. */
export const READBACK_MS = 2000;
export const READBACK_POLL_MS = 25;
/** The pointer is where it should be when the page reports it within this many CSS px on each axis. */
export const POINTER_TOLERANCE_PX = 2;
/** Corrections after the first placement. */
export const MAX_CORRECTIONS = 3;
/** A key that reads as held is read once more after this long (tabcap's own Shift may only just have come up). */
export const HELD_RECHECK_MS = 40;
/** The first move stops this many of the daemon's screen pixels short, so the second is a real move and the two calibrate the scale. */
export const CALIBRATION_STEP_PX = 16;

export type OsDeps = { sleep: (ms: number) => Promise<unknown>; now: () => number; rng: Rng };
export const OS_DEPS: OsDeps = { sleep: (ms) => Bun.sleep(ms), now: () => Date.now(), rng: Math.random };

/** Set when the command that owns the input has ended (timeout, dialog): every loop stops before its next system call. */
export type StopFlag = { stopped: boolean };

let loaded: OsInput | null = null;

/** `unsupported`: this platform has no OS-level input in tabcap (never a silent fall back to CDP input). */
export function unsupportedOs(platform: string, detail: string | null = null): TabcapError {
  return new TabcapError(
    "unsupported",
    detail === null ? `--os (operating-system input) is implemented on Windows only; this is ${platform}` : `--os (operating-system input) could not be set up on ${platform}: ${detail}`,
    "Nothing was sent. Use --trusted (CDP input: trusted events, no foreground needed) unless the control only reads operating-system input.",
    { platform },
  );
}

/** The platform's OsInput (bound once), or `unsupported`. */
export function loadOsInput(platform: string = process.platform): OsInput {
  if (platform !== "win32") throw unsupportedOs(platform);
  if (loaded !== null) return loaded;
  try {
    loaded = openWin32();
  } catch (e) {
    throw unsupportedOs(platform, e instanceof Error ? e.message : String(e));
  }
  return loaded;
}

/**
 * `kind`: `foreground` — another window, tab or browser surface has the
 * keyboard; `held` — a modifier key or mouse button is physically down, so
 * tabcap's keys would mean something else (Control + w closes the tab).
 */
export type FrontCheck = { ok: true; foreground: Foreground } | { ok: false; kind: "foreground" | "held"; why: string; foreground: Foreground | null };

/** Evaluated in tabcap's own isolated world of the tab's root document: the page's scripts cannot answer for it. */
export const FOCUS_EXPR = `document.hasFocus() && document.visibilityState === "visible"`;

/** Does the tab's document have focus and is it visible? Asked in the isolated world; throws when the page does not answer. */
export type PageFocus = () => Promise<boolean>;

/**
 * Would a key pressed now reach this tab, as the key tabcap means? The
 * foreground window must belong to tabcap's Chrome (the browser process owns
 * every Chrome window); the tab's document must say it has focus and is
 * visible, which is only true for the selected tab of the active window and
 * false while a browser bubble or another tab has it (focus emulation is
 * switched off on this path, so the answer is the real one); and no modifier
 * key or mouse button may be down on the real keyboard and mouse (SendInput
 * does not reset them: winuser.h, SendInput remarks).
 */
export async function frontCheck(os: OsInput, focused: PageFocus, browserPid: number, sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms)): Promise<FrontCheck> {
  const fg = os.foreground();
  if (fg === null) return { ok: false, kind: "foreground", why: "no window is in the foreground", foreground: null };
  if (fg.pid !== browserPid) return { ok: false, kind: "foreground", why: `the foreground window belongs to process ${fg.pid}, tabcap's Chrome is process ${browserPid}`, foreground: fg };
  let has = false;
  try {
    has = await focused();
  } catch (e) {
    return { ok: false, kind: "foreground", why: `the page did not say whether it has focus (${e instanceof Error ? e.message : String(e)})`, foreground: fg };
  }
  if (!has) return { ok: false, kind: "foreground", why: "Chrome is in front, but this tab does not have focus (another tab, a browser dialog or the address bar has it)", foreground: fg };
  let held = os.heldKeys();
  if (held.length > 0) {
    await sleep(HELD_RECHECK_MS);
    held = os.heldKeys();
  }
  if (held.length > 0) return { ok: false, kind: "held", why: `${held.join(" and ")} is held down on the real keyboard or mouse`, foreground: fg };
  return { ok: true, foreground: fg };
}

/** `sent`: keys already sent when the foreground was lost (null: nothing was sent at all). */
export function notForeground(c: Extract<FrontCheck, { ok: false }>, browserPid: number, sent: { keys: number; of: number } | null = null): TabcapError {
  const done = sent === null ? "nothing was sent" : `${sent.keys} of ${sent.of} keys were sent, then tabcap stopped`;
  return new TabcapError(
    "not-foreground",
    `the tabcap browser window is not what the keyboard and pointer go to (${c.why}); ${done}`,
    c.kind === "held"
      ? "Operating-system input is combined with whatever is held down on the real keyboard and mouse, so tabcap sends nothing meanwhile. Ask the human to let go of the keyboard and mouse, then run the command again; tabcap did not retry."
      : "Operating-system input goes to whatever is in front, so tabcap only sends it to its own Chrome window. Ask the human to click that window's title bar (a click inside the page counts as them taking over), then run the command again; tabcap did not retry. `--trusted` needs no foreground.",
    { reason: c.kind, foreground: c.foreground === null ? null : { pid: c.foreground.pid, window: c.foreground.window }, browserPid, ...(sent === null ? {} : sent) },
  );
}

export type FrontState = { before: Foreground | null; taken: boolean };

/**
 * Make the tab the one the keyboard goes to: nothing to do when it already is;
 * otherwise Page.bringToFront (focus ladder level 3), then wait for the system
 * to agree. Windows may refuse a background program the foreground: then this
 * is `not-foreground` and the human clicks the window; no workaround.
 */
export async function takeForeground(os: OsInput, bring: () => Promise<void>, focused: PageFocus, browserPid: number, deps: OsDeps = OS_DEPS): Promise<FrontState> {
  const before = os.foreground();
  let last = await frontCheck(os, focused, browserPid, deps.sleep);
  if (last.ok) return { before, taken: false };
  // The human is on the keyboard or mouse: bringing a window to the front under their hands helps nobody.
  if (last.kind === "held") throw notForeground(last, browserPid);
  await bring();
  const until = deps.now() + FOREGROUND_WAIT_MS;
  for (;;) {
    await deps.sleep(FOREGROUND_POLL_MS);
    last = await frontCheck(os, focused, browserPid, deps.sleep);
    if (last.ok) return { before, taken: true };
    if (deps.now() >= until) throw notForeground(last, browserPid);
  }
}

let osQueue: Promise<unknown> = Promise.resolve();

/**
 * One `--os` command at a time in the whole daemon: there is one keyboard and
 * one pointer, whatever the tab or session. The next command starts when the
 * one before has really ended, not when its caller stopped waiting for it.
 */
export function osExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = osQueue.then(fn, fn);
  osQueue = run.catch(() => undefined);
  return run;
}

export type ForegroundReport = { taken: boolean; restored: boolean };

/** How long the system has to show the earlier window as the foreground window again. */
export const RESTORE_WAIT_MS = 500;

/**
 * After the command: hand the foreground back to the window that had it, but
 * only when tabcap took it, the setting allows it (`chrome.restoreFront`), and
 * Chrome still has it (someone who switched away meanwhile is left alone).
 * `restored` is what the system shows afterwards, not what the call returned;
 * the change arrives a moment after the call (measured on a Windows runner,
 * CI run 43406046058: read at once it was still Chrome, 0.5 s later the
 * earlier window).
 */
export async function giveBack(os: OsInput, front: FrontState | null, browserPid: number, wanted: boolean, deps: Pick<OsDeps, "sleep" | "now"> = OS_DEPS): Promise<ForegroundReport> {
  if (front === null || !front.taken) return { taken: false, restored: false };
  const before = front.before;
  if (!wanted || before === null || before.pid === browserPid) return { taken: true, restored: false };
  if (os.foreground()?.pid !== browserPid) return { taken: true, restored: false };
  if (!os.activate(before.window)) return { taken: true, restored: false };
  const until = deps.now() + RESTORE_WAIT_MS;
  for (;;) {
    if (os.foreground()?.window === before.window) return { taken: true, restored: true };
    if (deps.now() >= until) return { taken: true, restored: false };
    await deps.sleep(FOREGROUND_POLL_MS);
  }
}

/** The system took none of a record: `not-delivered`, nothing more is sent. */
function refused(what: string, extra: Record<string, unknown> = {}): TabcapError {
  return new TabcapError(
    "not-delivered",
    `the operating system did not take ${what} (SendInput returned 0)`,
    "Another program is blocking input (SendInput fails while another thread blocks it). tabcap did not retry.",
    extra,
  );
}

function put(os: OsInput, record: Uint8Array, what: string, extra: Record<string, unknown> = {}): void {
  if (os.send(record, 1) !== 1) throw refused(what, extra);
}

export const stoppedError = (sent: { keys: number; of: number } | null) =>
  new TabcapError("timeout", `the command ended before its input was complete${sent === null ? "" : ` (${sent.keys} of ${sent.of} keys were sent)`}`, "Check the page (`tabcap snapshot`); raise --timeout for a long text.", sent ?? {});

/** Longest a run of strokes takes, for the check against the command's time limit. */
export function strokesMs(strokes: readonly OsStroke[], delayMs: number): number {
  let ms = 0;
  for (const [i, s] of strokes.entries()) ms += (i > 0 ? delayMs : 0) + OS_KEY_HOLD_MS + (s.kind === "scan" && s.shift ? 2 * OS_MODIFIER_GAP_MS : 0);
  return ms;
}

export type StrokeRun = {
  delayMs: number;
  /** Scan code of the Shift key on the layout (strokes with `shift`). */
  shiftScan: number;
  check: () => Promise<FrontCheck>;
  browserPid: number;
  stop: StopFlag;
  deps?: OsDeps;
};

/**
 * Send the strokes one by one: before each, the foreground check; Shift is
 * held around a shifted key and always released, also when the key itself
 * fails. Returns the number of keys sent (all of them). A failure names how
 * many went out before it.
 */
export async function sendStrokes(os: OsInput, strokes: readonly OsStroke[], o: StrokeRun): Promise<number> {
  const deps = o.deps ?? OS_DEPS;
  const of = strokes.length;
  let keys = 0;
  for (const [i, s] of strokes.entries()) {
    if (i > 0 && o.delayMs > 0) await deps.sleep(o.delayMs);
    if (o.stop.stopped) throw stoppedError({ keys, of });
    const c = await o.check();
    if (!c.ok) throw notForeground(c, o.browserPid, { keys, of });
    if (o.stop.stopped) throw stoppedError({ keys, of });
    const r = strokeRecords(s);
    const shift = s.kind === "scan" && s.shift ? holdRecords(o.shiftScan) : null;
    if (shift !== null) {
      put(os, shift.down, "the Shift key", { keys, of });
      await deps.sleep(OS_MODIFIER_GAP_MS);
    }
    try {
      put(os, r.down, "a key", { keys, of });
      try {
        await deps.sleep(OS_KEY_HOLD_MS);
      } finally {
        // A key that went down always comes up, whatever happened meanwhile.
        os.send(r.up, 1);
      }
    } finally {
      if (shift !== null) {
        await deps.sleep(OS_MODIFIER_GAP_MS);
        os.send(shift.up, 1);
      }
    }
    keys++;
  }
  return keys;
}

/** One key with modifiers held around it (`press-key --os`): modifiers down in order, the key, modifiers up in reverse. */
export async function sendChord(os: OsInput, modifierScans: readonly number[], key: OsStroke, o: Omit<StrokeRun, "delayMs" | "shiftScan">): Promise<void> {
  const deps = o.deps ?? OS_DEPS;
  if (o.stop.stopped) throw stoppedError(null);
  const c = await o.check();
  if (!c.ok) throw notForeground(c, o.browserPid);
  const held: Uint8Array[] = [];
  try {
    for (const scan of modifierScans) {
      const m = holdRecords(scan);
      put(os, m.down, "a modifier key");
      held.push(m.up);
      await deps.sleep(OS_MODIFIER_GAP_MS);
    }
    const r = strokeRecords(key);
    put(os, r.down, "the key");
    try {
      await deps.sleep(OS_KEY_HOLD_MS);
    } finally {
      os.send(r.up, 1);
    }
  } finally {
    for (const up of held.reverse()) {
      await deps.sleep(OS_MODIFIER_GAP_MS);
      os.send(up, 1);
    }
  }
}

// ---------------------------------------------------------------- pointer

/**
 * The record of trusted pointer events in the target's document: capture phase,
 * nothing prevented, primary button only. Called on the node (or document) as
 * resolved in tabcap's isolated world, so the page's scripts can neither see
 * the listeners nor feed them.
 */
export const POINTER_WATCH_FN = `function () {
  const doc = this.nodeType === 9 ? this : this.ownerDocument;
  const el = this.nodeType === 9 ? null : (this.nodeType === 1 ? this : this.parentElement);
  const view = doc.defaultView;
  const st = { n: 0, x: 0, y: 0, pd: false, md: false, w: view.innerWidth, h: view.innerHeight };
  const mv = (e) => { if (e.isTrusted) { st.n++; st.x = e.clientX; st.y = e.clientY; } };
  const dn = (e) => { if (e.isTrusted && e.button === 0 && (el === null || el.contains(e.target))) { if (e.type === "pointerdown") st.pd = true; else st.md = true; } };
  view.addEventListener("mousemove", mv, true);
  view.addEventListener("pointerdown", dn, true);
  view.addEventListener("mousedown", dn, true);
  st.off = () => { view.removeEventListener("mousemove", mv, true); view.removeEventListener("pointerdown", dn, true); view.removeEventListener("mousedown", dn, true); };
  return st;
}`;
export const POINTER_READ_FN = `function () { return { n: this.n, x: this.x, y: this.y, pointerdown: this.pd, mousedown: this.md, w: this.w, h: this.h }; }`;
export const POINTER_OFF_FN = `function () { this.off(); return true; }`;

/** Where the top-level viewport is on the screen, as the page sees it (an estimate: the closed loop does the rest). */
export const VIEW_EXPR = `({ sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio })`;

export type ViewInfo = { sx: number; sy: number; ow: number; oh: number; iw: number; ih: number; dpr: number };

/** Parse the page's answer to VIEW_EXPR (untrusted); null when a number is missing. */
export function viewOf(v: unknown): ViewInfo | null {
  if (!isRecord(v)) return null;
  const out = { sx: num(v, "sx"), sy: num(v, "sy"), ow: num(v, "ow"), oh: num(v, "oh"), iw: num(v, "iw"), ih: num(v, "ih"), dpr: num(v, "dpr") };
  if (out.sx === null || out.sy === null || out.ow === null || out.oh === null || out.iw === null || out.ih === null || out.dpr === null) return null;
  if (!(out.dpr > 0) || !(out.iw > 0) || !(out.ih > 0)) return null;
  return { sx: out.sx, sy: out.sy, ow: out.ow, oh: out.oh, iw: out.iw, ih: out.ih, dpr: out.dpr };
}

/**
 * First guesses for a viewport point as absolute pointer coordinates. The
 * window's frame is taken to be equally thick left, right and below, with the
 * tab strip and toolbars above the viewport. Whether the daemon's screen units
 * are device pixels or scaled ones depends on how Windows treats the process,
 * so both scales are offered (once when they are the same); the page's
 * readback decides.
 */
export function estimates(p: Point, v: ViewInfo, screen: ScreenRect): Point[] {
  const side = Math.max(0, (v.ow - v.iw) / 2);
  const top = Math.max(0, v.oh - v.ih - side);
  const at = { x: v.sx + side + p.x, y: v.sy + top + p.y };
  const scales = Math.abs(v.dpr - 1) < 0.01 ? [1] : [1, v.dpr];
  return scales.map((s) => toAbsolute({ x: at.x * s, y: at.y * s }, screen));
}

export type Readback = { n: number; x: number; y: number };
export type Placement = { at: Point; moves: number; corrections: number };

function notSeen(extra: Record<string, unknown> = {}): TabcapError {
  return new TabcapError(
    "not-delivered",
    "the page did not see the pointer where tabcap put it, so nothing was pressed",
    "tabcap did not retry. The browser window may be partly off screen or covered, or the page zoom is not 100 %; look with `tabcap screenshot`. `click --trusted` needs no screen position.",
    extra,
  );
}

/**
 * Put the pointer on `target` (CSS px in the watched document) and prove it by
 * the page's own `mousemove` reports. Two moves near the first guess measure
 * how many absolute units one CSS pixel is on each axis; corrections then use
 * that. Returns where the page last saw the pointer, within
 * POINTER_TOLERANCE_PX of the target; otherwise `not-delivered` and no press.
 */
export async function placePointer(
  os: OsInput,
  read: () => Promise<Readback>,
  target: Point,
  guesses: readonly Point[],
  step: Point,
  stop: StopFlag,
  deps: OsDeps = OS_DEPS,
): Promise<Placement> {
  let moves = 0;
  const moveAndRead = async (p: Point): Promise<Readback | null> => {
    if (stop.stopped) throw stoppedError(null);
    const before = (await read()).n;
    put(os, moveRecord(p.x, p.y), "a pointer move");
    moves++;
    const until = deps.now() + READBACK_MS;
    for (;;) {
      await deps.sleep(READBACK_POLL_MS);
      const r = await read();
      if (r.n > before) return r;
      if (deps.now() >= until) return null;
    }
  };
  for (const guess of guesses) {
    const a = { x: guess.x - step.x, y: guess.y - step.y };
    const ra = await moveAndRead(a);
    if (ra === null) continue;
    let cur = guess;
    let rc = await moveAndRead(cur);
    if (rc === null) continue;
    // Absolute units per CSS pixel, measured; a degenerate pair cannot calibrate.
    const kx = (cur.x - a.x) / (rc.x - ra.x);
    const ky = (cur.y - a.y) / (rc.y - ra.y);
    if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx <= 0 || ky <= 0) throw notSeen({ reason: "no-scale", saw: [ra, rc].map((r) => ({ x: r.x, y: r.y })) });
    for (let corrections = 0; ; corrections++) {
      const ex = target.x - rc.x;
      const ey = target.y - rc.y;
      if (Math.abs(ex) <= POINTER_TOLERANCE_PX && Math.abs(ey) <= POINTER_TOLERANCE_PX) return { at: { x: rc.x, y: rc.y }, moves, corrections };
      const next = { x: cur.x + kx * ex, y: cur.y + ky * ey };
      if (corrections >= MAX_CORRECTIONS || (Math.round(next.x) === Math.round(cur.x) && Math.round(next.y) === Math.round(cur.y))) {
        throw notSeen({ reason: "off-target", off: { x: Math.round(ex), y: Math.round(ey) }, corrections });
      }
      const r = await moveAndRead(next);
      if (r === null) throw notSeen({ reason: "no-readback", corrections });
      cur = next;
      rc = r;
    }
  }
  throw notSeen({ reason: "no-readback", guesses: guesses.length });
}

/** The calibration step as absolute units. */
export function calibrationStep(screen: ScreenRect): Point {
  const o = toAbsolute({ x: screen.x, y: screen.y }, screen);
  const s = toAbsolute({ x: screen.x + CALIBRATION_STEP_PX, y: screen.y + CALIBRATION_STEP_PX }, screen);
  return { x: s.x - o.x, y: s.y - o.y };
}

/**
 * The step with its signs chosen so that the first move (guess − step) lies
 * towards the middle of the watched document (`size`, CSS px) rather than
 * beyond its edge: a target in the left half is approached from the right.
 */
export function stepInside(step: Point, target: Point, size: { w: number; h: number }): Point {
  return { x: target.x < size.w / 2 ? -Math.abs(step.x) : Math.abs(step.x), y: target.y < size.h / 2 ? -Math.abs(step.y) : Math.abs(step.y) };
}

/** Primary button down, the gap, up, at the pointer's place; the foreground is checked first. Returns the gap. */
export async function pressButton(os: OsInput, o: { check: () => Promise<FrontCheck>; browserPid: number; stop: StopFlag; deps?: OsDeps }): Promise<number> {
  const deps = o.deps ?? OS_DEPS;
  if (o.stop.stopped) throw stoppedError(null);
  const c = await o.check();
  if (!c.ok) throw notForeground(c, o.browserPid);
  const v = deps.rng();
  const unit = typeof v === "number" && v >= 0 && v < 1 ? v : 0;
  const gap = Math.round(PRESS_GAP_MS.min + unit * (PRESS_GAP_MS.max - PRESS_GAP_MS.min));
  // SendInput presses physical buttons: with the buttons swapped, the primary one is the right one.
  const swapped = os.buttonsSwapped();
  put(os, mouseRecord({ dx: 0, dy: 0, flags: swapped ? MOUSEEVENTF.rightDown : MOUSEEVENTF.leftDown }), "the button press");
  try {
    await deps.sleep(gap);
  } finally {
    os.send(mouseRecord({ dx: 0, dy: 0, flags: swapped ? MOUSEEVENTF.rightUp : MOUSEEVENTF.leftUp }), 1);
  }
  return gap;
}

/** `--at x,y` → a viewport point; anything else is a usage error. */
export function parseAt(spec: string): Point {
  const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(spec);
  if (m === null || m[1] === undefined || m[2] === undefined) throw new TabcapError("usage", `bad --at: ${JSON.stringify(spec.slice(0, 40))}`, "Use --at <x>,<y>: CSS pixels from the top left of the page's viewport, e.g. --at 640,360.");
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** Wrap an OsInput so every record the system took is counted (the audit number of `browser status`). */
export function counting(os: OsInput, count: (n: number) => void): OsInput {
  return {
    platform: os.platform,
    foreground: () => os.foreground(),
    layout: (thread) => os.layout(thread),
    keyFor: (unit, layout) => os.keyFor(unit, layout),
    scanCode: (vk, layout) => os.scanCode(vk, layout),
    capsLock: () => os.capsLock(),
    heldKeys: () => os.heldKeys(),
    buttonsSwapped: () => os.buttonsSwapped(),
    send: (records, n) => {
      const took = os.send(records, n);
      if (took > 0) count(took);
      return took;
    },
    screen: () => os.screen(),
    activate: (window) => os.activate(window),
  };
}

export const logOs = (what: string, fields: Record<string, unknown>): void => log.info(`os input: ${what}`, fields);
