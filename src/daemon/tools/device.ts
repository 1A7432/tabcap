// tabcap resize <w> <h> | tabcap emulate … (docs/08 §5; parameter sets and
// semantics after chrome-devtools-mcp resize_page / emulate, see emulatespec.ts
// and NOTICE). Both act on one tab of the session.
//
// resize: the tab's window gets the content size asked for (Browser.setContentsSize,
// falling back to Browser.setWindowBounds with the measured frame); a maximised
// or full-screen window is made normal first. Background tabs share their
// window, so the other tabs in it change size too — the answer lists them.
// emulate: every call replaces all earlier settings of the tab (a setting left
// out is cleared); the settings live on the tab, and their throttling scales
// the post-action wait. Chrome applies network throttling only while the
// Network domain is enabled on the tab's session (measured 0.4-B: Slow 3G gave
// a 300 KB fetch 8 s while recording and 1 ms otherwise), so emulated network
// conditions keep Network enabled on the tab until they are cleared; wait --idle
// and net stop leave it on for such a tab.

import { TabcapError } from "../../shared/envelope.ts";
import { isRecord, num, str } from "../../shared/json.ts";
import { log } from "../../shared/log.ts";
import type { Daemon } from "../state.ts";
import { optStr, type Args } from "./args.ts";
import { emulationCalls, parseEmulate } from "./emulatespec.ts";
import { timeoutOf } from "./navigate.ts";
import { networkHeldByWait } from "./wait.ts";

/** `resize 1280 800`: positive whole CSS px (CDP accepts at most 10000000). */
export function parseSize(a: Args): { width: number; height: number } {
  const n = (k: string) => {
    const v = a[k];
    const x = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isSafeInteger(x) || x < 1 || x > 10_000_000) throw new TabcapError("usage", `${k} must be a positive whole number of CSS pixels`, "Usage: tabcap resize <width> <height>, e.g. tabcap resize 1280 800");
    return x;
  };
  return { width: n("width"), height: n("height") };
}

const VIEWPORT_EXPR = "({ w: window.innerWidth, h: window.innerHeight })";

export async function resize(d: Daemon, a: Args, session: string): Promise<unknown> {
  const want = parseSize(a);
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      const w = await t.send("Browser.getWindowForTarget", { targetId: tab.targetId }, null, 5000);
      const windowId = num(w, "windowId");
      const bounds = isRecord(w["bounds"]) ? w["bounds"] : {};
      if (windowId === null) throw new TabcapError("cdp", "Browser.getWindowForTarget returned no window", "Retry; if it persists the tab may have no window (navigate again).");
      const state = str(bounds, "windowState");
      if (state !== null && state !== "normal") {
        await t.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }, null, 5000);
        // Ubuntu needs it twice when leaving full screen (chrome-devtools-mcp resize_page).
        if (state === "fullscreen") await t.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }, null, 5000);
      }
      let method = "Browser.setContentsSize";
      try {
        await t.send("Browser.setContentsSize", { windowId, width: want.width, height: want.height }, null, 5000);
      } catch (e) {
        // Older Chrome: size the window by the frame around the current viewport.
        log.info("resize: Browser.setContentsSize failed, sizing the window instead", { error: e instanceof Error ? e.message : String(e) });
        method = "Browser.setWindowBounds";
        const cur = await viewport(d, tab.sessionId);
        const fw = (num(bounds, "width") ?? cur.w) - cur.w;
        const fh = (num(bounds, "height") ?? cur.h) - cur.h;
        await t.send("Browser.setWindowBounds", { windowId, bounds: { width: want.width + fw, height: want.height + fh } }, null, 5000);
      }
      await Bun.sleep(100);
      const got = await viewport(d, tab.sessionId);
      if (got.w !== want.width || got.h !== want.height) {
        // Diagnostics only: the window the OS actually gave us (e.g. clamped to the screen).
        const after: unknown = await t.send("Browser.getWindowBounds", { windowId }, null, 5000).then((r) => r["bounds"] ?? null, (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
        log.info("resize: viewport differs from the request", { requested: want, viewport: got, method, boundsBefore: bounds, boundsAfter: after });
      }
      const shared = tabs.sessionTabs(session).filter((x) => x !== tab).map((x) => x.id);
      return {
        tab: tab.id,
        windowId,
        requested: want,
        viewport: { width: got.w, height: got.h },
        method,
        ...(tab.emulation.viewport === undefined ? {} : { note: "this tab has an emulated viewport (tabcap emulate --viewport); the page keeps seeing that size" }),
        ...(shared.length > 0 ? { otherTabs: shared, otherTabsNote: "the session's other tabs may share this window and changed size too" } : {}),
      };
    },
    { timeoutMs: timeoutOf(a) },
  );
}

async function viewport(d: Daemon, sessionId: string): Promise<{ w: number; h: number }> {
  const { t } = d.need();
  const r = await t.send("Runtime.evaluate", { expression: VIEWPORT_EXPR, returnByValue: true }, sessionId, 5000);
  const v = isRecord(r["result"]) && isRecord(r["result"]["value"]) ? r["result"]["value"] : {};
  return { w: typeof v["w"] === "number" ? v["w"] : 0, h: typeof v["h"] === "number" ? v["h"] : 0 };
}

export async function emulate(d: Daemon, a: Args, session: string): Promise<unknown> {
  const settings = parseEmulate(a);
  const { t, tabs } = d.need();
  const tab = tabs.pick(session, optStr(a, "tab"));
  return tabs.run(
    tab,
    async () => {
      const recording = d.recorders.has(tab.session);
      // Throttling needs the Network domain on (see the header); a recording has it on already.
      if (settings.networkConditions !== undefined && !recording) await t.send("Network.enable", {}, tab.sessionId, 10_000);
      for (const c of emulationCalls(settings)) await t.send(c.method, c.params, tab.sessionId, 10_000);
      const wasThrottled = tab.emulation.networkConditions !== undefined;
      tab.emulation = settings;
      if (wasThrottled && settings.networkConditions === undefined && !recording && !networkHeldByWait(tab.sessionId)) {
        await t.send("Network.disable", {}, tab.sessionId, 5000).catch(() => undefined);
      }
      const cleared = (["viewport", "userAgent", "colorScheme", "networkConditions", "cpuThrottlingRate", "geolocation"] as const).filter((k) => settings[k] === undefined);
      return {
        tab: tab.id,
        emulation: settings,
        cleared,
        note: `each emulate call replaces all earlier settings of this tab; pass every setting you want in one call${settings.geolocation === undefined ? "" : "; the page still has to be granted the geolocation permission"}`,
      };
    },
    { timeoutMs: timeoutOf(a) },
  );
}
