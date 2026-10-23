// tabcap permission grant|deny|reset <name>... (0.9-B, docs/04 §46)
//
// `Browser.setPermission` for ONE origin: the current tab's, or `--origin`. There
// is no "all origins" spelling: CDP without `origin` applies to every origin
// (measured, docs/07 §1.1 E2) and the owner chose the narrow default. `reset`
// sets `prompt` for that origin, which is a single-origin restore; it does not
// use `Browser.resetPermissions`, which clears the whole context.
// A session with its own browser context (a pool account, a proxy-bound
// session) passes that `browserContextId`, so only it is affected; any other
// session shares the default context, and the answer says so.
// Settings live in the running browser only (Chrome writes none to the
// profile); nothing is stored by tabcap.
//
// The names are `Browser.PermissionDescriptor.name`, handed to Chrome as given.
// KNOWN_PERMISSIONS below is a hint table for "did you mean", never a filter.

import { TabcapError } from "../../shared/envelope.ts";
import type { Daemon } from "../state.ts";
import type { Transport } from "../transport/types.ts";
import { optStr, optStrList, type Args } from "./args.ts";
import { timeoutOf } from "./navigate.ts";

export type PermissionSetting = "granted" | "denied" | "prompt";

const SETTINGS: readonly string[] = ["granted", "denied", "prompt"];

/**
 * Permission names `Browser.setPermission` takes. Every one was accepted by Chrome for Testing 155.0.8059.84
 * (probed with `permission grant <name>`, 2026-10-23; `fullscreen` with the descriptor below). Only used to suggest the closest name after Chrome
 * refused one; a name missing here is still sent to Chrome.
 */
export const KNOWN_PERMISSIONS: readonly string[] = [
  "accelerometer",
  "ambient-light-sensor",
  "background-fetch",
  "background-sync",
  "camera",
  "captured-surface-control",
  "clipboard-read",
  "clipboard-write",
  "display-capture",
  "fullscreen",
  "geolocation",
  "gyroscope",
  "idle-detection",
  "keyboard-lock",
  "local-fonts",
  "local-network-access",
  "magnetometer",
  "microphone",
  "midi",
  "nfc",
  "notifications",
  "payment-handler",
  "periodic-background-sync",
  "persistent-storage",
  "pointer-lock",
  "push",
  "screen-wake-lock",
  "speaker-selection",
  "storage-access",
  "system-wake-lock",
  "top-level-storage-access",
  "web-app-installation",
  "window-management",
];

/** The names people ask for first; what the hint lists when nothing known is near the name Chrome refused. */
const COMMON_PERMISSIONS = ["geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write", "midi", "push"] as const;

/** A name in `Browser.PermissionDescriptor.name`'s spelling (untrusted CLI input: no spaces, quotes or control characters). */
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_NAMES = 32;

const usage = (message: string, next: string): TabcapError => new TabcapError("usage", message, next);

/** `grant` / `deny` / `reset` arrive as the fixed argument `setting`. */
export function parseSetting(a: Args): PermissionSetting {
  const v = optStr(a, "setting");
  if (v === null || !SETTINGS.includes(v)) throw usage(`permission setting ${JSON.stringify(v)}?`, "Use `tabcap permission grant|deny|reset <name>...`.");
  return v === "granted" ? "granted" : v === "denied" ? "denied" : "prompt";
}

/** The permission names of the command, in the order given, duplicates dropped. */
export function parseNames(a: Args): string[] {
  const raw = optStrList(a, "names");
  if (raw.length === 0) throw usage("missing <names>", "Usage: tabcap permission grant|deny|reset <name>... [--origin <url>], e.g. `tabcap permission grant geolocation notifications`.");
  const names = [...new Set(raw)];
  if (names.length > MAX_NAMES) throw usage(`${names.length} permission names (at most ${MAX_NAMES})`, "Split them over several commands.");
  for (const n of names) {
    if (!NAME_SHAPE.test(n)) throw usage(`not a permission name: ${JSON.stringify(n.length > 40 ? `${n.slice(0, 40)}…` : n)}`, "Names are Chrome's permission names, lower-case with hyphens: geolocation, notifications, camera, clipboard-read ...");
  }
  return names;
}

/**
 * The origin the permission is set for: `--origin`'s origin (path, query and fragment dropped), else the
 * current tab's. Only http(s) origins have permissions; `about:blank`, `data:`, `chrome-error://` and
 * `file:` pages do not.
 */
export function permissionOrigin(tabUrl: string, originArg: string | null): string {
  const raw = originArg ?? tabUrl;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw originArg === null
      ? usage("the current page has no origin to set a permission for", "Run `tabcap navigate <url>` to the site first, or pass `--origin <url>`.")
      : usage("--origin is not an absolute URL", "Pass the site's URL, e.g. `--origin https://example.com/`.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw originArg === null
      ? usage(`the current page (${u.protocol}) has no http(s) origin to set a permission for`, "Run `tabcap navigate <url>` to that site first, or pass `--origin <url>`.")
      : usage(`--origin must be an http(s) URL (got ${u.protocol})`, "Pass the site's URL, e.g. `--origin https://example.com/`.");
  }
  return u.origin;
}

/**
 * The descriptor Chrome wants: `push` needs `userVisibleOnly:true` and `fullscreen` needs
 * `allowWithoutGesture:true` (Chrome refuses either without; measured CfT 155, docs/07 §1.1 E2 / E2d);
 * the rest is the bare name.
 */
export function descriptorOf(name: string): Record<string, unknown> {
  if (name === "push") return { name, userVisibleOnly: true };
  if (name === "fullscreen") return { name, allowWithoutGesture: true };
  return { name };
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** The known name nearest to `name` (case-insensitive edit distance), or null when none is near enough to be a guess. */
export function closestPermission(name: string, known: readonly string[] = KNOWN_PERMISSIONS): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = distance(lower, k);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.ceil(lower.length / 3)) ? best : null;
}

const INVALID_NAME = /Invalid PermissionDescriptor name/i;

/**
 * What a failed `Browser.setPermission` becomes. Chrome's refusal of a name is a `usage` error that keeps
 * Chrome's words and points at the nearest known name; any other browser error stays `cdp`. Both carry
 * `result: {applied}`: the names set before this one (they are not rolled back).
 */
export function permissionError(e: unknown, name: string, applied: readonly string[]): Error {
  if (!(e instanceof Error)) return new Error(String(e));
  if (e.name !== "CdpError") return e;
  const result = { applied: [...applied] };
  if (INVALID_NAME.test(e.message)) {
    const near = closestPermission(name);
    const next =
      near === null
        ? `Chrome does not know "${name}". Names it takes include ${COMMON_PERMISSIONS.join(", ")} (Browser.PermissionDescriptor.name).`
        : `Did you mean \`${near}\`? Names are Chrome's own (Browser.PermissionDescriptor.name).`;
    return new TabcapError("usage", e.message, applied.length === 0 ? next : `${next} Already set before this: ${applied.join(", ")}.`, { result });
  }
  return new TabcapError("cdp", e.message, applied.length === 0 ? "Retry; the browser refused the permission." : `Retry the rest; already set: ${applied.join(", ")}.`, { result });
}

export type PermissionRequest = { names: string[]; setting: PermissionSetting; origin: string; browserContextId: string | null };

/** Set each name in the order given; the first failure stops it (what was set stays set). */
export async function applyPermissions(t: Transport, req: PermissionRequest, timeoutMs: number): Promise<void> {
  const applied: string[] = [];
  for (const name of req.names) {
    try {
      await t.send("Browser.setPermission", { permission: descriptorOf(name), setting: req.setting, origin: req.origin, ...(req.browserContextId === null ? {} : { browserContextId: req.browserContextId }) }, null, timeoutMs);
    } catch (e) {
      throw permissionError(e, name, applied);
    }
    applied.push(name);
  }
}

const GEO_NOTE =
  "geolocation: a page's own location request stays pending in a `hidden` tab (the background tabs tabcap opens; a window's only tab is visible), granted or not. It is answered only while focus emulation is on (during `click --trusted` and the like). Give the position with `tabcap emulate --geolocation lat,lon`.";

/** The `note` of the answer (null: nothing to say). */
export function permissionNote(o: { names: readonly string[]; origin: string; shared: boolean }): string | null {
  const parts: string[] = [];
  if (o.shared) parts.push(`this session uses the browser's default context: every session that opens ${o.origin} sees this setting until \`browser stop\`; a session started with \`session start --site\` has a context of its own.`);
  if (o.names.includes("geolocation")) parts.push(GEO_NOTE);
  return parts.length === 0 ? null : parts.join(" ");
}

/** `ext` mode has no Browser domain (the extension relays page targets only). */
export function directOnly(kind: Transport["kind"]): void {
  if (kind === "ext") throw new TabcapError("unsupported", "permissions are not available in ext mode: the Browser domain does not go through the extension", "Use the direct mode (`tabcap browser start`).");
}

export async function permission(d: Daemon, a: Args, session: string): Promise<unknown> {
  const setting = parseSetting(a);
  const names = parseNames(a);
  const originArg = optStr(a, "origin");
  const { t, tabs } = d.need();
  directOnly(t.kind);
  const tab = tabs.pick(session, optStr(a, "tab"));
  const budget = timeoutOf(a);
  return tabs.run(
    tab,
    async () => {
      const origin = permissionOrigin(tab.url, originArg);
      const browserContextId = tabs.contexts.get(tab.session) ?? null;
      await applyPermissions(t, { names, setting, origin, browserContextId }, Math.min(budget, 10_000));
      const shared = browserContextId === null;
      const note = permissionNote({ names, origin, shared });
      return { tab: tab.id, origin, setting, names, context: shared ? "default" : "session", shared, ...(note === null ? {} : { note }) };
    },
    { timeoutMs: budget },
  );
}
