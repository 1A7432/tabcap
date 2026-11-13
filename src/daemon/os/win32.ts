// OS-level input on Windows (docs/16 §5): user32.dll through bun:ffi, no native
// component. Every function here is one system call; the decisions (which
// window may receive keys, when to stop) are in tools/osinput.ts.
//
// Signatures: winuser.h. HWND and HKL are pointer-sized handles, carried as
// u64. Not run on a Windows machine from this repository's own machines: the
// Windows e2e (test/e2e/v12c) is where these bindings are exercised.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { INPUT_SIZE, type Foreground, type KeyLookup, type OsInput, type ScreenRect } from "./input.ts";

const MAPVK_VK_TO_VSC = 0;
const MAPVK_VK_TO_CHAR = 2;
const VK_CAPITAL = 0x14;
const SM_SWAPBUTTON = 23;
/** GetAsyncKeyState: the keys and buttons whose being down would change what tabcap's input means. */
const HELD: ReadonlyArray<readonly [number, string]> = [
  [0x10, "Shift"],
  [0x11, "Control"],
  [0x12, "Alt"],
  [0x5b, "Windows"],
  [0x5c, "Windows"],
  [0x01, "a mouse button"],
  [0x02, "a mouse button"],
];
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n);
const int = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0);

/** Bind user32.dll. Throws when the library or a symbol is missing (the caller reports `unsupported`). */
export function openWin32(): OsInput {
  const { symbols: u } = dlopen("user32.dll", {
    SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    GetForegroundWindow: { args: [], returns: FFIType.u64 },
    GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    GetKeyboardLayout: { args: [FFIType.u32], returns: FFIType.u64 },
    VkKeyScanExW: { args: [FFIType.u16, FFIType.u64], returns: FFIType.i16 },
    MapVirtualKeyExW: { args: [FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u32 },
    GetKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
    GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
    GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  });
  return {
    platform: "win32",
    foreground(): Foreground | null {
      const hwnd = big(u.GetForegroundWindow());
      if (hwnd === 0n) return null;
      const pid = new Uint32Array(1);
      const thread = int(u.GetWindowThreadProcessId(hwnd, ptr(pid)));
      if (thread === 0) return null;
      return { window: hwnd.toString(16), pid: pid[0] ?? 0, thread };
    },
    layout: (thread) => big(u.GetKeyboardLayout(thread)),
    keyFor(codeUnit, layout): KeyLookup | null {
      const r = int(u.VkKeyScanExW(codeUnit & 0xffff, layout));
      if (r === -1) return null;
      const state = (r >> 8) & 0xff;
      const vk = r & 0xff;
      // MAPVK_VK_TO_CHAR sets the top bit of its answer for a dead key (winuser.h, MapVirtualKeyExW).
      const dead = int(u.MapVirtualKeyExW(vk, MAPVK_VK_TO_CHAR, layout)) >>> 31 === 1;
      return { vk, shift: (state & 1) !== 0, ctrl: (state & 2) !== 0, alt: (state & 4) !== 0, dead };
    },
    scanCode: (vk, layout) => int(u.MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout)),
    capsLock: () => (int(u.GetKeyState(VK_CAPITAL)) & 1) !== 0,
    // The most significant bit of GetAsyncKeyState's SHORT: the key is down now.
    heldKeys: () => [...new Set(HELD.filter(([vk]) => (int(u.GetAsyncKeyState(vk)) & 0x8000) !== 0).map(([, name]) => name))],
    buttonsSwapped: () => int(u.GetSystemMetrics(SM_SWAPBUTTON)) !== 0,
    send(records, count): number {
      if (count <= 0 || records.byteLength < count * INPUT_SIZE) return 0;
      return int(u.SendInput(count, ptr(records), INPUT_SIZE));
    },
    screen(): ScreenRect {
      return {
        x: int(u.GetSystemMetrics(SM_XVIRTUALSCREEN)),
        y: int(u.GetSystemMetrics(SM_YVIRTUALSCREEN)),
        width: int(u.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
        height: int(u.GetSystemMetrics(SM_CYVIRTUALSCREEN)),
      };
    },
    activate(window): boolean {
      if (!/^[0-9a-f]{1,16}$/.test(window)) return false;
      return int(u.SetForegroundWindow(BigInt(`0x${window}`))) !== 0;
    },
  };
}
