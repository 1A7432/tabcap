// OS-level input, the pure part (docs/16): the interface the daemon needs from
// the operating system, the Win32 `INPUT` records as bytes, and the plan that
// turns text or a named key into key strokes. No FFI here; os/win32.ts binds
// the interface to user32.dll, tests use a fake.
//
// Oracle for the record layout: winuser.h (Windows SDK), `INPUT`, `KEYBDINPUT`,
// `MOUSEINPUT` on a 64-bit target (LLP64):
//   INPUT        { DWORD type; <4 pad>; union { MOUSEINPUT mi; KEYBDINPUT ki; } }   40 bytes
//   KEYBDINPUT   { WORD wVk; WORD wScan; DWORD dwFlags; DWORD time; <4 pad>; ULONG_PTR dwExtraInfo; }
//   MOUSEINPUT   { LONG dx; LONG dy; DWORD mouseData; DWORD dwFlags; DWORD time; <4 pad>; ULONG_PTR dwExtraInfo; }
// so type is at 0, the union at 8: ki.wVk 8, ki.wScan 10, ki.dwFlags 12;
// mi.dx 8, mi.dy 12, mi.mouseData 16, mi.dwFlags 20. Not measured on Windows
// from this repository's machines; the e2e on a Windows runner is the check.

/** The foreground window and who owns it. `window` is the handle, lowercase hex. */
export type Foreground = { window: string; pid: number; thread: number };

/** What VkKeyScanExW says about one UTF-16 code unit on a layout. */
export type KeyLookup = { vk: number; shift: boolean; ctrl: boolean; alt: boolean; dead: boolean };

/** The virtual screen in the daemon process's own units (GetSystemMetrics). */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** What tabcap needs from the operating system for `--os` input. Synchronous: every call is one system call. */
export interface OsInput {
  readonly platform: string;
  foreground(): Foreground | null;
  /** The keyboard layout handle of a window's thread. */
  layout(thread: number): bigint;
  /** The key that types this UTF-16 code unit on the layout, or null when it has none. */
  keyFor(codeUnit: number, layout: bigint): KeyLookup | null;
  /** The scan code of a virtual key on the layout; 0 when it has none. */
  scanCode(vk: number, layout: bigint): number;
  capsLock(): boolean;
  /** Modifier keys and mouse buttons that are physically down right now (names for the error message); empty when none. */
  heldKeys(): string[];
  /** The user swapped the primary and secondary mouse buttons (the primary one is then the physical right button). */
  buttonsSwapped(): boolean;
  /** Send `count` INPUT records (INPUT_SIZE bytes each); the number the system took. */
  send(records: Uint8Array, count: number): number;
  screen(): ScreenRect;
  /** Make a window the foreground window; false when the system refused. */
  activate(window: string): boolean;
}

export const INPUT_SIZE = 40;
export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;
export const KEYEVENTF = { extended: 0x0001, keyUp: 0x0002, unicode: 0x0004, scanCode: 0x0008 } as const;
export const MOUSEEVENTF = { move: 0x0001, leftDown: 0x0002, leftUp: 0x0004, rightDown: 0x0008, rightUp: 0x0010, virtualDesk: 0x4000, absolute: 0x8000 } as const;
export const VK = { shift: 0x10, control: 0x11, alt: 0x12, enter: 0x0d, tab: 0x09 } as const;
/** Absolute pointer coordinates run 0 … 65535 over the virtual screen on each axis. */
export const ABSOLUTE_MAX = 65535;

/** One keyboard INPUT record. `time` 0: the system stamps it; `dwExtraInfo` 0. */
export function keyRecord(o: { vk: number; scan: number; flags: number }): Uint8Array {
  const b = new Uint8Array(INPUT_SIZE);
  const v = new DataView(b.buffer);
  v.setUint32(0, INPUT_KEYBOARD, true);
  v.setUint16(8, o.vk & 0xffff, true);
  v.setUint16(10, o.scan & 0xffff, true);
  v.setUint32(12, o.flags >>> 0, true);
  return b;
}

/** One mouse INPUT record. */
export function mouseRecord(o: { dx: number; dy: number; flags: number }): Uint8Array {
  const b = new Uint8Array(INPUT_SIZE);
  const v = new DataView(b.buffer);
  v.setUint32(0, INPUT_MOUSE, true);
  v.setInt32(8, Math.round(o.dx), true);
  v.setInt32(12, Math.round(o.dy), true);
  v.setUint32(20, o.flags >>> 0, true);
  return b;
}

/** An absolute pointer move to (nx, ny), each 0 … ABSOLUTE_MAX over the virtual screen. */
export function moveRecord(nx: number, ny: number): Uint8Array {
  const clamp = (n: number) => Math.min(ABSOLUTE_MAX, Math.max(0, Math.round(n)));
  return mouseRecord({ dx: clamp(nx), dy: clamp(ny), flags: MOUSEEVENTF.move | MOUSEEVENTF.absolute | MOUSEEVENTF.virtualDesk });
}

/** A pixel of the virtual screen (in the daemon's units) as an absolute coordinate. */
export function toAbsolute(p: { x: number; y: number }, s: ScreenRect): { x: number; y: number } {
  const one = (v: number, from: number, size: number) => (size <= 1 ? 0 : ((v - from) * ABSOLUTE_MAX) / (size - 1));
  return { x: one(p.x, s.x, s.width), y: one(p.y, s.y, s.height) };
}

/**
 * One stroke of the plan: a key by scan code (`scan`, with Shift held when
 * `shift`), or a UTF-16 code unit sent as itself (`unit`, KEYEVENTF_UNICODE).
 */
export type OsStroke = { kind: "scan"; scan: number; extended: boolean; shift: boolean } | { kind: "unit"; unit: number };

export type OsPlan = { ok: true; strokes: OsStroke[] } | { ok: false; index: number; why: "no-key" | "needs-altgr" | "dead-key" | "no-scan-code" };

/** Virtual keys whose scan code carries the E0 prefix (the navigation cluster). */
const EXTENDED_VK: ReadonlySet<number> = new Set([33, 34, 35, 36, 37, 38, 39, 40, 45, 46]);
export const isExtendedVk = (vk: number): boolean => EXTENDED_VK.has(vk);

type Layout = { keyFor: (codeUnit: number) => KeyLookup | null; scanCode: (vk: number) => number };

/**
 * Text → key strokes by scan code on a layout. "\n" (and a lone "\r") is Enter,
 * "\r\n" one Enter, "\t" Tab. A character the layout cannot type with a plain
 * or a Shift stroke (no key, AltGr, a dead key) fails the whole plan (`index` is its position in UTF-16
 * code units): nothing is sent for a text that cannot be typed whole.
 */
export function planScanKeys(text: string, layout: Layout): OsPlan {
  const strokes: OsStroke[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue;
    const fixed = unit === 0x0a || unit === 0x0d ? VK.enter : unit === 0x09 ? VK.tab : null;
    const k: KeyLookup | null = fixed === null ? layout.keyFor(unit) : { vk: fixed, shift: false, ctrl: false, alt: false, dead: false };
    if (k === null) return { ok: false, index: i, why: "no-key" };
    if (k.ctrl || k.alt) return { ok: false, index: i, why: "needs-altgr" };
    // A dead key types nothing by itself and changes the next character ('a → á): the text would come out different.
    if (k.dead) return { ok: false, index: i, why: "dead-key" };
    const scan = layout.scanCode(k.vk);
    if (scan === 0) return { ok: false, index: i, why: "no-scan-code" };
    strokes.push({ kind: "scan", scan, extended: isExtendedVk(k.vk), shift: k.shift });
  }
  return { ok: true, strokes };
}

/**
 * Text → strokes that carry the characters themselves (`--os-text`): no layout,
 * no input method. Line ends and tabs are still the Enter and Tab keys.
 */
export function planUnicode(text: string, layout: Pick<Layout, "scanCode">): OsPlan {
  const strokes: OsStroke[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue;
    const fixed = unit === 0x0a || unit === 0x0d ? VK.enter : unit === 0x09 ? VK.tab : null;
    if (fixed === null) {
      strokes.push({ kind: "unit", unit });
      continue;
    }
    const scan = layout.scanCode(fixed);
    if (scan === 0) return { ok: false, index: i, why: "no-scan-code" };
    strokes.push({ kind: "scan", scan, extended: false, shift: false });
  }
  return { ok: true, strokes };
}

/** The down and up records of one stroke (Shift is the caller's). */
export function strokeRecords(s: OsStroke): { down: Uint8Array; up: Uint8Array } {
  if (s.kind === "unit") {
    return { down: keyRecord({ vk: 0, scan: s.unit, flags: KEYEVENTF.unicode }), up: keyRecord({ vk: 0, scan: s.unit, flags: KEYEVENTF.unicode | KEYEVENTF.keyUp }) };
  }
  const flags = KEYEVENTF.scanCode | (s.extended ? KEYEVENTF.extended : 0);
  return { down: keyRecord({ vk: 0, scan: s.scan, flags }), up: keyRecord({ vk: 0, scan: s.scan, flags: flags | KEYEVENTF.keyUp }) };
}

/** A key held around others (Shift, Control, Alt), by scan code. */
export function holdRecords(scan: number): { down: Uint8Array; up: Uint8Array } {
  return { down: keyRecord({ vk: 0, scan, flags: KEYEVENTF.scanCode }), up: keyRecord({ vk: 0, scan, flags: KEYEVENTF.scanCode | KEYEVENTF.keyUp }) };
}

/** The low word of a layout handle, the language id: 4 lowercase hex digits (0409 = English, United States). */
export function layoutName(layout: bigint): string {
  return (layout & 0xffffn).toString(16).padStart(4, "0");
}
