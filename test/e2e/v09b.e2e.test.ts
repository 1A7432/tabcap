// L2 for 0.9-B: `tabcap permission grant|deny|reset` (docs/04 §46, docs/05 s73).
// Oracle: what the page itself sees, asked in its own world with
// navigator.permissions.query (the range's /s73 page) and what its
// getCurrentPosition did (/s73/geo). tabcap's answers are checked against §46;
// the literal states are Chrome's own words (prompt / granted / denied).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S73_NAMES, startPermissionSite, type PermissionSite } from "./site.ts";
import { cliFor, rec, s, until } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const A = ["--session", "a"];

let home = "";
let site: PermissionSite;
const { tabcap, ok } = cliFor(() => home, { nonJson: "exit" });

type States = Record<(typeof S73_NAMES)[number], string>;
const ALL_PROMPT: States = { geolocation: "prompt", notifications: "prompt", "clipboard-read": "prompt", camera: "prompt", midi: "prompt" };

/** The permission states the page at `tab` of `session` reports through navigator.permissions.query. */
async function stateOf(session: string, tab: string): Promise<unknown> {
  return (await ok("evaluate", "s73State()", "--await", "--session", session, "--tab", tab))["value"];
}

describe.skipIf(!enabled)("tabcap 0.9-B L2 (permissions on s73)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e09b-"));
    site = startPermissionSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    removeHome(home, import.meta.file);
  });

  test("1. grant two names for the tab's origin only: A sees them, B (same default context) sees nothing; the answer says shared and carries the geolocation note", async () => {
    const nav = await ok("navigate", `${site.a}/s73`, ...A);
    expect(nav["tab"]).toBe("t1");
    expect(await stateOf("a", "t1")).toEqual(ALL_PROMPT);

    const granted = await ok("permission", "grant", "geolocation", "notifications", ...A);
    expect(granted).toMatchObject({ tab: "t1", origin: site.a, setting: "granted", names: ["geolocation", "notifications"], context: "default", shared: true });
    const note = s(granted["note"]);
    expect(note).toContain("default context");
    expect(note).toContain("geolocation");
    expect(note).toContain("hidden");
    expect(note).toContain("emulate --geolocation");
    expect(await stateOf("a", "t1")).toEqual({ ...ALL_PROMPT, geolocation: "granted", notifications: "granted" });

    // another origin in the same default context was not touched
    const other = await ok("tab", "new", `${site.b}/s73`, ...A);
    expect(other["tab"]).toBe("t2");
    expect(await stateOf("a", "t2")).toEqual(ALL_PROMPT);
  }, 120_000);

  test("2. deny, then reset: reset goes back to prompt for that name only, the others keep their state", async () => {
    const denied = await ok("permission", "deny", "geolocation", "--tab", "t1", ...A);
    expect(denied).toMatchObject({ origin: site.a, setting: "denied", names: ["geolocation"], shared: true });
    expect(await stateOf("a", "t1")).toEqual({ ...ALL_PROMPT, geolocation: "denied", notifications: "granted" });

    const reset = await ok("permission", "reset", "geolocation", "--tab", "t1", ...A);
    expect(reset).toMatchObject({ origin: site.a, setting: "prompt", names: ["geolocation"] });
    expect(await stateOf("a", "t1")).toEqual({ ...ALL_PROMPT, notifications: "granted" });
  }, 60_000);

  test("3. push is accepted (userVisibleOnly is added); a misspelt name is a usage error with Chrome's words and the nearest name; a later bad name keeps the earlier ones", async () => {
    const push = await ok("permission", "grant", "push", "--tab", "t1", ...A);
    expect(push).toMatchObject({ origin: site.a, names: ["push"], setting: "granted" });
    expect(push["note"]).not.toContain("hidden");
    const pushState = (await ok("evaluate", "navigator.permissions.query({ name: 'push', userVisibleOnly: true }).then((p) => p.state)", "--await", "--tab", "t1", ...A))["value"];
    expect(pushState).toBe("granted");

    const typo = await tabcap(["permission", "grant", "geolocaton", "--tab", "t1", ...A]);
    expect(typo.ok).toBe(false);
    expect(typo.error?.["code"]).toBe("usage");
    expect(s(typo.error?.["message"])).toContain("Invalid PermissionDescriptor name: geolocaton");
    expect(s(typo.error?.["next"])).toContain("geolocation");
    expect(rec(typo.error?.["result"])["applied"]).toEqual([]);

    const partial = await tabcap(["permission", "grant", "notifications", "geolocaton", "--tab", "t1", ...A]);
    expect(partial.error?.["code"]).toBe("usage");
    expect(rec(partial.error?.["result"])["applied"]).toEqual(["notifications"]);
    // what was set before the failure stays set
    expect(rec(await stateOf("a", "t1"))["notifications"]).toBe("granted");
  }, 60_000);

  test("4. origin: about:blank has none (usage); --origin takes the URL's origin only; a file: URL is refused", async () => {
    const blank = await ok("tab", "new", "about:blank", ...A);
    expect(blank["tab"]).toBe("t3");
    const none = await tabcap(["permission", "grant", "camera", ...A]);
    expect(none.ok).toBe(false);
    expect(none.error?.["code"]).toBe("usage");
    expect(s(none.error?.["next"])).toContain("--origin");

    const viaOrigin = await ok("permission", "grant", "camera", "--origin", `${site.b}/any/path?q=1#frag`, ...A);
    expect(viaOrigin).toMatchObject({ tab: "t3", origin: site.b, setting: "granted", names: ["camera"] });
    expect(rec(await stateOf("a", "t2"))["camera"]).toBe("granted");
    expect(rec(await stateOf("a", "t1"))["camera"]).toBe("prompt");

    for (const bad of ["file:///tmp", "about:blank", "not a url"]) {
      const e = await tabcap(["permission", "grant", "camera", "--origin", bad, ...A]);
      expect([bad, e.error?.["code"]]).toEqual([bad, "usage"]);
    }
  }, 60_000);

  test("5. a pool account's session has its own context: shared false, the default context's session does not see it, and the account's context starts at prompt", async () => {
    const SITE = "example";
    const add = await tabcap(["site", "add", SITE, "--url", `${site.a}/s73`, "--user", "alice", "--password-stdin"], "Site-pass-e2e-9b01\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    const started = await ok("session", "start", "p", "--site", SITE, "--account", "alice");
    expect(started).toMatchObject({ account: "alice", browserContext: "own" });
    const pt = s((await ok("navigate", `${site.a}/s73`, "--session", "p"))["tab"]);
    expect(await stateOf("p", pt)).toEqual(ALL_PROMPT);

    const granted = await ok("permission", "grant", "midi", "--session", "p");
    expect(granted).toMatchObject({ origin: site.a, setting: "granted", names: ["midi"], context: "session", shared: false });
    expect(granted["note"]).toBeUndefined();
    expect(await stateOf("p", pt)).toEqual({ ...ALL_PROMPT, midi: "granted" });
    // session a's page at the same origin lives in the default context
    expect(rec(await stateOf("a", "t1"))["midi"]).toBe("prompt");
    await ok("session", "stop", "p");
  }, 120_000);

  test("6. geolocation: granted plus an emulated position is answered only while focus emulation is on (click --trusted); a hidden tab's own request hangs", async () => {
    // a second tab of the window is a background tab: hidden (the window's only tab is visible and answers at once)
    const geo = s((await ok("tab", "new", `${site.a}/s73/geo`, ...A))["tab"]);
    const T = ["--tab", geo, ...A];
    expect((await ok("evaluate", "document.visibilityState", ...T))["value"]).toBe("hidden");
    await ok("emulate", "--geolocation", "31.23,121.47", ...T);
    await ok("permission", "grant", "geolocation", ...T);
    const tree = s((await ok("snapshot", "--interactive", ...T))["tree"]);
    const ref = /button "locate" \[(e\d+)\]/.exec(tree)?.[1];
    if (ref === undefined) throw new Error(`no locate button in:\n${tree}`);

    // without focus emulation the page's request stays pending until its own 4 s timeout
    expect((await ok("evaluate", "s73Geo()", "--await", ...T))["value"]).toEqual({ hung: true });

    expect(await ok("click", ref, "--trusted", ...T)).toMatchObject({ trusted: true });
    const out = await until(
      "the position in #out",
      async () => (await ok("evaluate", "document.getElementById('out').textContent", ...T))["value"],
      (v) => typeof v === "string" && v !== "",
    );
    expect(JSON.parse(s(out))).toEqual({ lat: 31.23, lon: 121.47 });
  }, 120_000);

  test("7. the settings live in the running browser only: after browser stop and start every state is prompt again", async () => {
    await ok("browser", "stop");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    const nav = await ok("navigate", `${site.a}/s73`, ...A);
    expect(nav["tab"]).toBe("t1");
    expect(await stateOf("a", "t1")).toEqual(ALL_PROMPT);
    // B too: camera was granted there
    await ok("navigate", `${site.b}/s73`, ...A);
    expect(await stateOf("a", "t1")).toEqual(ALL_PROMPT);
  }, 120_000);
});
