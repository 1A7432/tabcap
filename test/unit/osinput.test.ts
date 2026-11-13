// docs/16: operating-system input. Offline: the system calls are a fake OsInput, the page a fake transport.
// Oracle for the record bytes: winuser.h's INPUT / KEYBDINPUT / MOUSEINPUT layout on a 64-bit target
// (offsets written out in os/input.ts); the expected hex strings below are that layout filled in by hand.

import { describe, expect, test } from "bun:test";
import { TabcapError } from "../../src/shared/envelope.ts";
import {
  ABSOLUTE_MAX,
  INPUT_SIZE,
  KEYEVENTF,
  MOUSEEVENTF,
  keyRecord,
  layoutName,
  mouseRecord,
  moveRecord,
  planScanKeys,
  planUnicode,
  strokeRecords,
  toAbsolute,
  type Foreground,
  type KeyLookup,
  type OsInput,
  type OsStroke,
} from "../../src/daemon/os/input.ts";
import {
  calibrationStep,
  counting,
  HELD_RECHECK_MS,
  osExclusive,
  RESTORE_WAIT_MS,
  estimates,
  frontCheck,
  giveBack,
  loadOsInput,
  OS_KEY_HOLD_MS,
  OS_MODIFIER_GAP_MS,
  parseAt,
  placePointer,
  POINTER_TOLERANCE_PX,
  pressButton,
  sendChord,
  sendStrokes,
  stepInside,
  strokesMs,
  takeForeground,
  viewOf,
  type FrontCheck,
  type OsDeps,
  type Readback,
} from "../../src/daemon/tools/osinput.ts";
import { osChordOf, parseKey, untypableError } from "../../src/daemon/tools/input.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

type Rec = { type: number; vk: number; scan: number; flags: number; dx: number; dy: number; mouseFlags: number };
const dec = (b: Uint8Array): Rec => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { type: v.getUint32(0, true), vk: v.getUint16(8, true), scan: v.getUint16(10, true), flags: v.getUint32(12, true), dx: v.getInt32(8, true), dy: v.getInt32(12, true), mouseFlags: v.getUint32(20, true) };
};

// A US layout, as far as the tests type: scan codes of set 1.
const SCAN: Record<number, number> = { 0x41: 0x1e, 0x42: 0x30, 0x43: 0x2e, 0x58: 0x2d, 0x31: 0x02, 0x39: 0x0a, 0x0d: 0x1c, 0x09: 0x0f, 0x10: 0x2a, 0x11: 0x1d, 0x12: 0x38, 0xbf: 0x35, 0x25: 0x4b };
const usKey = (unit: number): KeyLookup | null => {
  const c = String.fromCharCode(unit);
  if (/[a-z]/.test(c)) return { vk: c.toUpperCase().charCodeAt(0), shift: false, ctrl: false, alt: false, dead: false };
  if (/[A-Z]/.test(c)) return { vk: unit, shift: true, ctrl: false, alt: false, dead: false };
  if (/[0-9]/.test(c)) return { vk: unit, shift: false, ctrl: false, alt: false, dead: false };
  if (c === "!") return { vk: 0x31, shift: true, ctrl: false, alt: false, dead: false };
  if (c === "/") return { vk: 0xbf, shift: false, ctrl: false, alt: false, dead: false };
  if (c === "?") return { vk: 0xbf, shift: true, ctrl: false, alt: false, dead: false };
  if (c === "€") return { vk: 0x45, shift: false, ctrl: true, alt: true, dead: false };
  if (c === "'") return { vk: 0xde, shift: false, ctrl: false, alt: false, dead: true };
  if (c === "+") return { vk: 0x39, shift: true, ctrl: false, alt: false, dead: false };
  return null;
};
const LAYOUT = { name: "0409", keyFor: usKey, scanCode: (vk: number) => SCAN[vk] ?? 0 };

type Fake = OsInput & { sent: Rec[]; fg: Foreground | null; activated: string[]; caps: boolean; take: number; held: string[][]; swapped: boolean };

function fakeOs(fg: Foreground | null = { window: "a1", pid: 500, thread: 7 }): Fake {
  const f: Fake = {
    platform: "fake",
    sent: [],
    fg,
    activated: [],
    caps: false,
    take: 1,
    foreground: () => f.fg,
    layout: () => 0x04090409n,
    keyFor: (u) => usKey(u),
    scanCode: (vk) => SCAN[vk] ?? 0,
    capsLock: () => f.caps,
    // each reading takes the next entry; the last one stays
    held: [[]],
    swapped: false,
    heldKeys: () => (f.held.length > 1 ? (f.held.shift() ?? []) : (f.held[0] ?? [])),
    buttonsSwapped: () => f.swapped,
    send: (records, n) => {
      if (f.take === 0) return 0;
      for (let i = 0; i < n; i++) f.sent.push(dec(records.subarray(i * INPUT_SIZE, (i + 1) * INPUT_SIZE)));
      return n;
    },
    screen: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    activate: (w) => {
      f.activated.push(w);
      f.fg = { window: w, pid: 900, thread: 9 };
      return true;
    },
  };
  return f;
}

/** Time that only moves when something sleeps. */
function clock(): OsDeps & { slept: number[]; t: number } {
  const c = {
    t: 0,
    slept: [] as number[],
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
    now: () => c.t,
    rng: () => 0.5,
  };
  return c;
}

const okCheck = async (): Promise<FrontCheck> => ({ ok: true, foreground: { window: "a1", pid: 500, thread: 7 } });
const code = (e: unknown): string => (e instanceof TabcapError ? e.code : `not a TabcapError: ${String(e)}`);
const extra = (e: unknown): Record<string, unknown> => (e instanceof TabcapError ? e.extra : {});
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("docs/16 INPUT records (winuser.h layout, 64-bit)", () => {
  // type, pad, wVk, wScan, dwFlags, time, pad, dwExtraInfo, then the 8 bytes the union is longer than KEYBDINPUT
  test("a record is 40 bytes; a key by scan code: type 1 at 0, wVk 8, wScan 10, dwFlags 12", () => {
    const down = keyRecord({ vk: 0, scan: 0x1e, flags: KEYEVENTF.scanCode });
    expect(down.byteLength).toBe(40);
    expect(hex(down)).toBe("01000000" + "00000000" + "0000" + "1e00" + "08000000" + "00000000" + "00000000" + "0000000000000000" + "0000000000000000");
    const up = keyRecord({ vk: 0, scan: 0x1e, flags: KEYEVENTF.scanCode | KEYEVENTF.keyUp });
    expect(hex(up)).toBe("01000000" + "00000000" + "0000" + "1e00" + "0a000000" + "00000000" + "00000000" + "0000000000000000" + "0000000000000000");
  });

  test("an extended key carries KEYEVENTF_EXTENDEDKEY; a character sent as itself is wVk 0, wScan = the code unit, KEYEVENTF_UNICODE", () => {
    const left = strokeRecords({ kind: "scan", scan: 0x4b, extended: true, shift: false });
    expect(dec(left.down)).toMatchObject({ type: 1, vk: 0, scan: 0x4b, flags: 0x0009 });
    expect(dec(left.up)).toMatchObject({ flags: 0x000b });
    const zhong = strokeRecords({ kind: "unit", unit: 0x4e2d });
    expect(hex(zhong.down)).toBe("01000000" + "00000000" + "0000" + "2d4e" + "04000000" + "00000000" + "00000000" + "0000000000000000" + "0000000000000000");
    expect(dec(zhong.up)).toMatchObject({ vk: 0, scan: 0x4e2d, flags: 0x0006 });
  });

  test("a mouse record: type 0, dx 8, dy 12, mouseData 16, dwFlags 20; an absolute move covers the virtual desktop", () => {
    const m = moveRecord(32768, 100);
    expect(hex(m)).toBe("00000000" + "00000000" + "00800000" + "64000000" + "00000000" + "01c00000" + "00000000" + "00000000" + "0000000000000000");
    expect(dec(m).mouseFlags).toBe(MOUSEEVENTF.move | MOUSEEVENTF.absolute | MOUSEEVENTF.virtualDesk);
    expect(dec(mouseRecord({ dx: 0, dy: 0, flags: MOUSEEVENTF.leftDown })).mouseFlags).toBe(0x0002);
    expect(dec(mouseRecord({ dx: 0, dy: 0, flags: MOUSEEVENTF.leftUp })).mouseFlags).toBe(0x0004);
    // out of range values are clamped, never wrapped
    expect(dec(moveRecord(-5, 70000))).toMatchObject({ dx: 0, dy: ABSOLUTE_MAX });
  });

  test("screen pixels → absolute coordinates: the corners of the virtual screen are 0 and 65535, also with a negative origin", () => {
    const s = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(toAbsolute({ x: 0, y: 0 }, s)).toEqual({ x: 0, y: 0 });
    expect(toAbsolute({ x: 1919, y: 1079 }, s)).toEqual({ x: 65535, y: 65535 });
    const two = { x: -1920, y: 0, width: 3840, height: 1080 };
    expect(toAbsolute({ x: -1920, y: 0 }, two).x).toBe(0);
    expect(Math.round(toAbsolute({ x: 0, y: 0 }, two).x)).toBe(Math.round((1920 * 65535) / 3839));
    expect(toAbsolute({ x: 5, y: 5 }, { x: 0, y: 0, width: 1, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  test("the layout's name is the low word of its handle, 4 lowercase hex digits", () => {
    expect(layoutName(0x04090409n)).toBe("0409");
    expect(layoutName(0xfffffffff0c00804n)).toBe("0804");
    expect(layoutName(0n)).toBe("0000");
  });
});

describe("docs/16 §4 text → key strokes", () => {
  test("letters, capitals (Shift), digits, punctuation; a line end is Enter, CRLF one Enter, a tab is Tab", () => {
    const p = planScanKeys("aB1!\r\n\tx\n", LAYOUT);
    expect(p).toEqual({
      ok: true,
      strokes: [
        { kind: "scan", scan: 0x1e, extended: false, shift: false },
        { kind: "scan", scan: 0x30, extended: false, shift: true },
        { kind: "scan", scan: 0x02, extended: false, shift: false },
        { kind: "scan", scan: 0x02, extended: false, shift: true },
        { kind: "scan", scan: 0x1c, extended: false, shift: false },
        { kind: "scan", scan: 0x0f, extended: false, shift: false },
        { kind: "scan", scan: 0x2d, extended: false, shift: false },
        { kind: "scan", scan: 0x1c, extended: false, shift: false },
      ],
    });
  });

  test("a character the layout cannot type fails the whole plan with its position; AltGr and a missing scan code too", () => {
    expect(planScanKeys("ab中c", LAYOUT)).toEqual({ ok: false, index: 2, why: "no-key" });
    expect(planScanKeys("a€", LAYOUT)).toEqual({ ok: false, index: 1, why: "needs-altgr" });
    // "9" has a scan code in the table, "5" has none
    expect(planScanKeys("95", LAYOUT)).toEqual({ ok: false, index: 1, why: "no-scan-code" });
    // an astral character is two code units, neither has a key
    expect(planScanKeys("a😀", LAYOUT)).toEqual({ ok: false, index: 1, why: "no-key" });
    expect(planScanKeys("", LAYOUT)).toEqual({ ok: true, strokes: [] });
    // a dead key would change the next character ('a → á), so the text is refused, not altered
    expect(planScanKeys("a'b", LAYOUT)).toEqual({ ok: false, index: 1, why: "dead-key" });
    expect(untypableError({ index: 1, why: "dead-key" }, "a'b", "0409", true).message).toContain("character 2 is a dead key");
  });

  test("--os-text: every code unit as itself (a surrogate pair is two), line ends and tabs still keys", () => {
    const p = planUnicode("中a😀\n", LAYOUT);
    expect(p).toEqual({
      ok: true,
      strokes: [
        { kind: "unit", unit: 0x4e2d },
        { kind: "unit", unit: 0x61 },
        { kind: "unit", unit: 0xd83d },
        { kind: "unit", unit: 0xde00 },
        { kind: "scan", scan: 0x1c, extended: false, shift: false },
      ],
    });
  });

  test("the refusal names the character by position, and by code point only when the text is not a secret", () => {
    const open = untypableError({ index: 2, why: "no-key" }, "ab中", "0409", false);
    expect(open.code).toBe("usage");
    expect(open.message).toContain("character 3 (U+4e2d) has no key on keyboard layout 0409");
    expect(open.message).toContain("nothing was sent");
    const hidden = untypableError({ index: 2, why: "no-key" }, "ab中", "0409", true);
    expect(hidden.message).toContain("character 3 has no key");
    expect(hidden.message).not.toContain("4e2d");
    expect(JSON.stringify(hidden.extra)).not.toContain("中");
    expect(untypableError({ index: 0, why: "needs-altgr" }, "€", "0407", false).message).toContain("AltGr");
  });

  test("how long the strokes take: the hold of each key, the gaps around Shift, the delay between two", () => {
    const strokes: OsStroke[] = [
      { kind: "scan", scan: 1, extended: false, shift: false },
      { kind: "scan", scan: 2, extended: false, shift: true },
      { kind: "unit", unit: 0x4e2d },
    ];
    expect(strokesMs(strokes, 100)).toBe(3 * OS_KEY_HOLD_MS + 2 * OS_MODIFIER_GAP_MS + 2 * 100);
    expect(strokesMs([], 100)).toBe(0);
  });
});

describe("docs/16 §3 the foreground", () => {
  const page = (focused: boolean | Error) => {
    const p = {
      asked: 0,
      brought: 0,
      focused: async (): Promise<boolean> => {
        p.asked++;
        if (focused instanceof Error) throw focused;
        return focused;
      },
      bring: async (): Promise<void> => {
        p.brought++;
      },
    };
    return p;
  };
  const noSleep = async () => undefined;

  test("in front and focused: ok; another process, no window, an unfocused tab, a page that does not answer: not ok, each with its reason", async () => {
    const os = fakeOs();
    expect((await frontCheck(os, page(true).focused, 500, noSleep)).ok).toBe(true);
    const other = await frontCheck(os, page(true).focused, 777, noSleep);
    expect(other).toMatchObject({ ok: false, kind: "foreground", foreground: { pid: 500 } });
    expect(other.ok ? "" : other.why).toContain("process 500");
    const none = await frontCheck(fakeOs(null), page(true).focused, 500, noSleep);
    expect(none).toMatchObject({ ok: false, kind: "foreground", foreground: null });
    const tab = await frontCheck(os, page(false).focused, 500, noSleep);
    expect(tab.ok ? "" : tab.why).toContain("does not have focus");
    const dead = await frontCheck(os, page(new Error("no answer")).focused, 500, noSleep);
    expect(dead.ok ? "" : dead.why).toContain("no answer");
    // the page is only asked when the window is Chrome's
    const p = page(true);
    await frontCheck(os, p.focused, 777, noSleep);
    expect(p.asked).toBe(0);
  });

  test("a modifier key or mouse button held on the real keyboard: not ok (held), after one more reading; a reading that clears is tabcap's own key coming up", async () => {
    const os = fakeOs();
    os.held = [["Control"], ["Control"]];
    const slept: number[] = [];
    const c = await frontCheck(os, page(true).focused, 500, async (ms) => {
      slept.push(ms);
    });
    expect(c).toMatchObject({ ok: false, kind: "held" });
    expect(c.ok ? "" : c.why).toContain("Control is held down");
    expect(slept).toEqual([HELD_RECHECK_MS]);
    const own = fakeOs();
    own.held = [["Shift"], []];
    expect((await frontCheck(own, page(true).focused, 500, noSleep)).ok).toBe(true);
    // the error tells the human to let go, not to click the window; nothing is brought to the front under their hands
    const busy = fakeOs({ window: "b2", pid: 500, thread: 7 });
    busy.held = [["Alt", "a mouse button"]];
    const p = page(true);
    const e = await caught(takeForeground(busy, p.bring, p.focused, 500, clock()));
    expect(code(e)).toBe("not-foreground");
    expect(extra(e)).toMatchObject({ reason: "held" });
    expect(e instanceof TabcapError ? e.next : "").toContain("let go");
    expect(e instanceof TabcapError ? e.message : "").toContain("Alt and a mouse button is held down");
    expect(p.brought).toBe(0);
  });

  test("already in front: nothing is brought; otherwise Page.bringToFront once, then the check until it holds", async () => {
    const os = fakeOs();
    const p = page(true);
    expect(await takeForeground(os, p.bring, p.focused, 500, clock())).toEqual({ before: { window: "a1", pid: 500, thread: 7 }, taken: false });
    expect(p.brought).toBe(0);

    const elsewhere = fakeOs({ window: "b2", pid: 900, thread: 9 });
    const q = page(true);
    const c = clock();
    const orig = c.sleep;
    let polls = 0;
    c.sleep = async (ms) => {
      await orig(ms);
      if (++polls === 3) elsewhere.fg = { window: "a1", pid: 500, thread: 7 };
    };
    expect(await takeForeground(elsewhere, q.bring, q.focused, 500, c)).toEqual({ before: { window: "b2", pid: 900, thread: 9 }, taken: true });
    expect(q.brought).toBe(1);
  });

  test("Chrome never comes to the front: not-foreground, nothing sent, and the error says who has it", async () => {
    const os = fakeOs({ window: "b2", pid: 900, thread: 9 });
    const p = page(true);
    const e = await caught(takeForeground(os, p.bring, p.focused, 500, clock()));
    expect(code(e)).toBe("not-foreground");
    expect(extra(e)).toEqual({ reason: "foreground", foreground: { pid: 900, window: "b2" }, browserPid: 500 });
    expect(e instanceof TabcapError ? e.message : "").toContain("nothing was sent");
    expect(e instanceof TabcapError ? e.next : "").toContain("title bar");
    expect(p.brought).toBe(1);
    expect(os.sent).toEqual([]);
  });

  test("handing back: only when taken, wanted, the earlier window was not Chrome's, and Chrome still has the foreground", async () => {
    const before = { window: "b2", pid: 900, thread: 9 };
    const os = fakeOs();
    expect(await giveBack(os, null, 500, true, clock())).toEqual({ taken: false, restored: false });
    expect(await giveBack(os, { before, taken: false }, 500, true, clock())).toEqual({ taken: false, restored: false });
    expect(await giveBack(os, { before, taken: true }, 500, false, clock())).toEqual({ taken: true, restored: false });
    expect(await giveBack(os, { before: { window: "a0", pid: 500, thread: 7 }, taken: true }, 500, true, clock())).toEqual({ taken: true, restored: false });
    expect(await giveBack(os, { before: null, taken: true }, 500, true, clock())).toEqual({ taken: true, restored: false });
    expect(os.activated).toEqual([]);
    expect(await giveBack(os, { before, taken: true }, 500, true, clock())).toEqual({ taken: true, restored: true });
    expect(os.activated).toEqual(["b2"]);
    // someone else took the foreground meanwhile: left alone
    const moved = fakeOs({ window: "c3", pid: 42, thread: 1 });
    expect(await giveBack(moved, { before, taken: true }, 500, true, clock())).toEqual({ taken: true, restored: false });
    expect(moved.activated).toEqual([]);
    // the system refuses: reported, not claimed
    const stuck = fakeOs();
    stuck.activate = () => false;
    expect(await giveBack(stuck, { before, taken: true }, 500, true, clock())).toEqual({ taken: true, restored: false });
  });

  test("handing back: the system shows the earlier window a moment after the call (as on the Windows runner); one that never shows is not claimed", async () => {
    const before = { window: "b2", pid: 900, thread: 9 };
    const late = fakeOs();
    const c = clock();
    late.activate = (w) => {
      late.activated.push(w);
      return true;
    };
    const orig = c.sleep;
    let polls = 0;
    c.sleep = async (ms) => {
      await orig(ms);
      if (++polls === 3) late.fg = before;
    };
    expect(await giveBack(late, { before, taken: true }, 500, true, c)).toEqual({ taken: true, restored: true });
    expect(polls).toBe(3);
    const never = fakeOs();
    never.activate = () => true;
    const d = clock();
    expect(await giveBack(never, { before, taken: true }, 500, true, d)).toEqual({ taken: true, restored: false });
    expect(d.t).toBeGreaterThanOrEqual(RESTORE_WAIT_MS);
  });
});

describe("docs/16 §3 keys", () => {
  const plan = (text: string): OsStroke[] => {
    const p = planScanKeys(text, LAYOUT);
    if (!p.ok) throw new Error("plan failed");
    return p.strokes;
  };
  const run = (os: Fake, c: OsDeps, check: () => Promise<FrontCheck> = okCheck, stop = { stopped: false }) => ({ delayMs: 120, shiftScan: 0x2a, check, browserPid: 500, stop, deps: c });

  test("each key: down, hold, up; a capital: Shift down, key, Shift up; the delay between two characters", async () => {
    const os = fakeOs();
    const c = clock();
    expect(await sendStrokes(os, plan("aB"), run(os, c))).toBe(2);
    expect(os.sent.map((r) => [r.scan, r.flags])).toEqual([
      [0x1e, 0x08],
      [0x1e, 0x0a],
      [0x2a, 0x08],
      [0x30, 0x08],
      [0x30, 0x0a],
      [0x2a, 0x0a],
    ]);
    expect(c.slept).toEqual([OS_KEY_HOLD_MS, 120, OS_MODIFIER_GAP_MS, OS_KEY_HOLD_MS, OS_MODIFIER_GAP_MS]);
  });

  test("the foreground is asked before every key; lost after two: not-foreground with keys 2 of 4, and not one record more", async () => {
    const os = fakeOs();
    let asked = 0;
    const check = async (): Promise<FrontCheck> => (++asked <= 2 ? okCheck() : { ok: false, kind: "foreground", why: "the foreground window belongs to process 900, tabcap's Chrome is process 500", foreground: { window: "b2", pid: 900, thread: 9 } });
    const e = await caught(sendStrokes(os, plan("abca"), run(os, clock(), check)));
    expect(code(e)).toBe("not-foreground");
    expect(extra(e)).toMatchObject({ keys: 2, of: 4, browserPid: 500, foreground: { pid: 900, window: "b2" } });
    expect(e instanceof TabcapError ? e.message : "").toContain("2 of 4 keys were sent");
    expect(os.sent.length).toBe(4);
    expect(asked).toBe(3);
  });

  test("the system takes nothing: not-delivered at once; a key that fails under Shift still releases Shift", async () => {
    const os = fakeOs();
    os.take = 0;
    const e = await caught(sendStrokes(os, plan("ab"), run(os, clock())));
    expect(code(e)).toBe("not-delivered");
    expect(extra(e)).toMatchObject({ keys: 0, of: 2 });

    const half = fakeOs();
    let n = 0;
    const real = half.send;
    half.send = (records, count) => (++n === 2 ? 0 : real(records, count)); // Shift goes down, the key does not
    const f = await caught(sendStrokes(half, plan("B"), run(half, clock())));
    expect(code(f)).toBe("not-delivered");
    expect(half.sent.map((r) => [r.scan, r.flags])).toEqual([
      [0x2a, 0x08],
      [0x2a, 0x0a],
    ]);
  });

  test("the command ended meanwhile (timeout, dialog): the loop stops before its next key", async () => {
    const os = fakeOs();
    const stop = { stopped: false };
    const c = clock();
    const orig = c.sleep;
    c.sleep = async (ms) => {
      await orig(ms);
      if (ms === 120) stop.stopped = true;
    };
    const e = await caught(sendStrokes(os, plan("abc"), run(os, c, okCheck, stop)));
    expect(code(e)).toBe("timeout");
    expect(extra(e)).toEqual({ keys: 1, of: 3 });
    expect(os.sent.length).toBe(2);
  });

  test("press-key: modifiers down in order, the key, modifiers up in reverse; nothing when the foreground is not ours", async () => {
    const os = fakeOs();
    const k = parseKey("Control+Shift+a");
    if (k === null) throw new Error("parseKey");
    const chord = osChordOf(k, "Control+Shift+a", LAYOUT);
    expect(chord).toEqual({ mods: [0x1d, 0x2a], key: { kind: "scan", scan: 0x1e, extended: false, shift: false } });
    await sendChord(os, chord.mods, chord.key, { check: okCheck, browserPid: 500, stop: { stopped: false }, deps: clock() });
    expect(os.sent.map((r) => [r.scan, r.flags])).toEqual([
      [0x1d, 0x08],
      [0x2a, 0x08],
      [0x1e, 0x08],
      [0x1e, 0x0a],
      [0x2a, 0x0a],
      [0x1d, 0x0a],
    ]);
    const blocked = fakeOs();
    const e = await caught(sendChord(blocked, [], chord.key, { check: async () => ({ ok: false, kind: "foreground", why: "x", foreground: null }), browserPid: 500, stop: { stopped: false }, deps: clock() }));
    expect(code(e)).toBe("not-foreground");
    expect(blocked.sent).toEqual([]);
  });

  test("press-key specs: named keys, the navigation cluster is extended, a single character is the key that types it (Shift included), Meta is refused", () => {
    const of = (spec: string) => {
      const k = parseKey(spec);
      if (k === null) throw new Error(`parseKey ${spec}`);
      return osChordOf(k, spec, LAYOUT);
    };
    expect(of("Enter")).toEqual({ mods: [], key: { kind: "scan", scan: 0x1c, extended: false, shift: false } });
    expect(of("ArrowLeft")).toEqual({ mods: [], key: { kind: "scan", scan: 0x4b, extended: true, shift: false } });
    expect(of("A")).toEqual({ mods: [0x2a], key: { kind: "scan", scan: 0x1e, extended: false, shift: false } });
    expect(of("?")).toEqual({ mods: [0x2a], key: { kind: "scan", scan: 0x35, extended: false, shift: false } });
    expect(of("Alt+x")).toEqual({ mods: [0x38], key: { kind: "scan", scan: 0x2d, extended: false, shift: false } });
    // punctuation under Control has no key code of its own: looked up, with the Shift it needs ("+" is Shift+9 on this fake layout)
    expect(of("Control++")).toEqual({ mods: [0x1d, 0x2a], key: { kind: "scan", scan: 0x0a, extended: false, shift: false } });
    expect(() => of("'")).toThrow(/dead key/);
    expect(() => of("Meta+a")).toThrow(/Meta/);
    expect(() => of("中")).toThrow(/no key/);
    // a named key the layout has no scan code for
    expect(() => of("PageDown")).toThrow(/no scan code/);
  });
});

describe("docs/16 §3 the pointer (closed loop)", () => {
  // The page as the loop sees it: an absolute position is some client position, by an origin and a scale the code does not know.
  function world(o: { originX: number; originY: number; unitsPerPx: number; left?: number; top?: number; width?: number; height?: number; noise?: number }) {
    const w = { n: 0, x: 0, y: 0, moves: [] as Array<{ x: number; y: number }> };
    const os = fakeOs();
    os.send = (records) => {
      const r = dec(records);
      if (r.type !== 0) return 1;
      os.sent.push(r);
      if ((r.mouseFlags & MOUSEEVENTF.move) === 0) return 1;
      const cx = (r.dx - o.originX) / o.unitsPerPx + (o.noise ?? 0);
      const cy = (r.dy - o.originY) / o.unitsPerPx + (o.noise ?? 0);
      w.moves.push({ x: r.dx, y: r.dy });
      // outside the watched document nothing is reported
      if (cx < (o.left ?? 0) || cy < (o.top ?? 0) || cx >= (o.width ?? 1280) || cy >= (o.height ?? 720)) return 1;
      w.n++;
      w.x = Math.round(cx);
      w.y = Math.round(cy);
      return 1;
    };
    const read = async (): Promise<Readback> => ({ n: w.n, x: w.x, y: w.y });
    return { w, os, read };
  }
  const step = calibrationStep({ x: 0, y: 0, width: 1920, height: 1080 });
  const stop = { stopped: false };

  test("the calibration step is 16 screen pixels as absolute units on each axis", () => {
    expect(Math.round(step.x)).toBe(Math.round((16 * 65535) / 1919));
    expect(Math.round(step.y)).toBe(Math.round((16 * 65535) / 1079));
  });

  test("a first guess 40 px off: two moves measure the scale, one correction lands within the tolerance", async () => {
    // true mapping: 34.15 units per px on both axes for simplicity
    const { w, os, read } = world({ originX: 3000, originY: 9000, unitsPerPx: 34.15 });
    const target = { x: 400, y: 300 };
    const guess = { x: 3000 + (400 + 40) * 34.15, y: 9000 + (300 - 25) * 34.15 };
    const r = await placePointer(os, read, target, [guess], { x: step.x, y: step.x }, stop, clock());
    expect(Math.abs(r.at.x - target.x)).toBeLessThanOrEqual(POINTER_TOLERANCE_PX);
    expect(Math.abs(r.at.y - target.y)).toBeLessThanOrEqual(POINTER_TOLERANCE_PX);
    expect(r).toMatchObject({ moves: 3, corrections: 1 });
    expect(w.moves.length).toBe(3);
  });

  test("the first move goes towards the middle of the watched document, so a target near an edge is not approached from outside", () => {
    const size = { w: 300, h: 80 };
    expect(stepInside({ x: 500, y: 900 }, { x: 40, y: 20 }, size)).toEqual({ x: -500, y: -900 });
    expect(stepInside({ x: 500, y: 900 }, { x: 290, y: 70 }, size)).toEqual({ x: 500, y: 900 });
    expect(stepInside({ x: -500, y: 900 }, { x: 290, y: 20 }, size)).toEqual({ x: 500, y: -900 });
  });

  test("a target in the top left corner: approached from inside (a negative step), the scale still comes out positive", async () => {
    const { w, os, read } = world({ originX: 3000, originY: 9000, unitsPerPx: 34.15 });
    const target = { x: 4, y: 3 };
    const guess = { x: 3000 + 9 * 34.15, y: 9000 + 6 * 34.15 };
    const r = await placePointer(os, read, target, [guess], stepInside({ x: step.x, y: step.x }, target, { w: 1280, h: 720 }), stop, clock());
    expect(Math.abs(r.at.x - target.x)).toBeLessThanOrEqual(POINTER_TOLERANCE_PX);
    expect(Math.abs(r.at.y - target.y)).toBeLessThanOrEqual(POINTER_TOLERANCE_PX);
    expect((w.moves[0]?.x ?? 0) > (w.moves[1]?.x ?? 0)).toBe(true);
  });

  test("a guess that is already right needs no correction; the first move is still a real move away from it", async () => {
    const { w, os, read } = world({ originX: 0, originY: 0, unitsPerPx: 34.15 });
    const r = await placePointer(os, read, { x: 100, y: 100 }, [{ x: 100 * 34.15, y: 100 * 34.15 }], { x: step.x, y: step.x }, stop, clock());
    expect(r).toMatchObject({ moves: 2, corrections: 0, at: { x: 100, y: 100 } });
    expect(w.moves[0]?.x).not.toBe(w.moves[1]?.x);
  });

  test("the first guess is outside the document (no report): the second guess is tried; none reports: not-delivered, nothing pressed", async () => {
    const { os, read } = world({ originX: 20000, originY: 20000, unitsPerPx: 30 });
    const target = { x: 50, y: 50 };
    const good = { x: 20000 + 50 * 30, y: 20000 + 50 * 30 };
    const r = await placePointer(os, read, target, [{ x: 100, y: 100 }, good], { x: 400, y: 400 }, stop, clock());
    expect(r.at).toEqual({ x: 50, y: 50 });
    const lost = world({ originX: 20000, originY: 20000, unitsPerPx: 30 });
    const e = await caught(placePointer(lost.os, lost.read, target, [{ x: 100, y: 100 }], { x: 400, y: 400 }, stop, clock()));
    expect(code(e)).toBe("not-delivered");
    expect(extra(e)).toMatchObject({ reason: "no-readback" });
    expect(lost.os.sent.every((x) => (x.mouseFlags & (MOUSEEVENTF.leftDown | MOUSEEVENTF.leftUp)) === 0)).toBe(true);
  });

  test("a page whose reports never come within the tolerance: bounded corrections, then not-delivered with the offset", async () => {
    // every report is 5 px off the true position: the loop chases it and gives up
    let flip = 1;
    const { os, read } = world({ originX: 0, originY: 0, unitsPerPx: 30 });
    const jitter = async (): Promise<Readback> => {
      const r = await read();
      return { n: r.n, x: r.x + 6 * flip, y: r.y };
    };
    const real = os.send;
    os.send = (records, n) => {
      flip = -flip;
      return real(records, n);
    };
    const e = await caught(placePointer(os, jitter, { x: 300, y: 300 }, [{ x: 300 * 30, y: 300 * 30 }], { x: 400, y: 400 }, stop, clock()));
    expect(code(e)).toBe("not-delivered");
    expect(["off-target", "no-scale"]).toContain(String(extra(e)["reason"]));
  });

  test("two reports at the same place cannot calibrate: not-delivered (no-scale)", async () => {
    const os = fakeOs();
    let n = 0;
    os.send = () => {
      n++;
      return 1;
    };
    const e = await caught(placePointer(os, async () => ({ n, x: 10, y: 10 }), { x: 300, y: 300 }, [{ x: 9000, y: 9000 }], { x: 400, y: 400 }, stop, clock()));
    expect(code(e)).toBe("not-delivered");
    expect(extra(e)).toMatchObject({ reason: "no-scale" });
  });

  test("the press: the foreground first, then down, the gap, up; never when the foreground is someone else's", async () => {
    const os = fakeOs();
    const c = clock();
    const gap = await pressButton(os, { check: okCheck, browserPid: 500, stop, deps: c });
    expect(gap).toBe(95);
    expect(os.sent.map((r) => r.mouseFlags)).toEqual([0x0002, 0x0004]);
    expect(c.slept).toEqual([95]);
    // swapped buttons: the primary button is the physical right one
    const sw = fakeOs();
    sw.swapped = true;
    await pressButton(sw, { check: okCheck, browserPid: 500, stop, deps: clock() });
    expect(sw.sent.map((r) => r.mouseFlags)).toEqual([0x0008, 0x0010]);
    const no = fakeOs();
    const e = await caught(pressButton(no, { check: async () => ({ ok: false, kind: "foreground", why: "x", foreground: null }), browserPid: 500, stop, deps: clock() }));
    expect(code(e)).toBe("not-foreground");
    expect(no.sent).toEqual([]);
  });

  test("first guesses: the window's frame is split evenly, the tab strip is above; one scale at 100 %, two otherwise", () => {
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    const v = viewOf({ sx: 100, sy: 50, ow: 1016, oh: 800, iw: 1000, ih: 700, dpr: 1 });
    if (v === null) throw new Error("viewOf");
    const one = estimates({ x: 10, y: 20 }, v, screen);
    expect(one.length).toBe(1);
    // side frame 8, top 800 - 700 - 8 = 92 → screen point (118, 162)
    expect(one[0]).toEqual(toAbsolute({ x: 118, y: 162 }, screen));
    const scaled = estimates({ x: 10, y: 20 }, { ...v, dpr: 1.5 }, screen);
    expect(scaled).toEqual([toAbsolute({ x: 118, y: 162 }, screen), toAbsolute({ x: 177, y: 243 }, screen)]);
    expect(viewOf({ sx: 1, sy: 1, ow: 1, oh: 1, iw: 0, ih: 1, dpr: 1 })).toBeNull();
    expect(viewOf({ sx: "1" })).toBeNull();
    expect(viewOf(null)).toBeNull();
  });

  test("--at: x,y in CSS pixels; anything else is a usage error that does not echo a long value", () => {
    expect(parseAt("640,360")).toEqual({ x: 640, y: 360 });
    expect(parseAt(" 12.5 , 7 ")).toEqual({ x: 12.5, y: 7 });
    for (const bad of ["640", "a,b", "-1,5", "1,2,3", ""]) expect(() => parseAt(bad)).toThrow(/bad --at/);
    try {
      parseAt("x".repeat(500));
    } catch (e) {
      expect(e instanceof TabcapError ? e.message.length : 999).toBeLessThan(80);
    }
  });
});

describe("docs/16 §3 one --os command at a time", () => {
  test("the next command starts when the one before has really ended, also after a failure; results and errors pass through", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = osExclusive(async () => {
      order.push("a:start");
      await gate;
      order.push("a:end");
      throw new Error("a failed");
    });
    const second = osExclusive(async () => {
      order.push("b:start");
      return 7;
    });
    await Bun.sleep(5);
    expect(order).toEqual(["a:start"]);
    release();
    expect(String(await caught(first))).toContain("a failed");
    expect(await second).toBe(7);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });
});

describe("docs/16 §5 platforms and the audit count", () => {
  test("anything but Windows is `unsupported`: never a silent fall back to CDP input", () => {
    for (const p of ["darwin", "linux", "freebsd"]) {
      try {
        loadOsInput(p);
        throw new Error("expected unsupported");
      } catch (e) {
        expect(code(e)).toBe("unsupported");
        expect(extra(e)).toEqual({ platform: p });
        expect(e instanceof TabcapError ? e.next : "").toContain("--trusted");
      }
    }
  });

  test("every record the system took is counted, a refused one is not", () => {
    const os = fakeOs();
    let n = 0;
    const c = counting(os, (k) => {
      n += k;
    });
    c.send(keyRecord({ vk: 0, scan: 0x1e, flags: KEYEVENTF.scanCode }), 1);
    c.send(moveRecord(1, 1), 1);
    os.take = 0;
    c.send(moveRecord(1, 1), 1);
    expect(n).toBe(2);
    expect(c.foreground()).toEqual(os.foreground());
    expect(c.capsLock()).toBe(false);
  });
});
