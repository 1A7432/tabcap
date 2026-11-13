// L2 for docs/16 (docs/05 s82): `--os`, input through the operating system.
// Oracle: the page's own event log (`window.__s82`: every key and pointer event with isTrusted, where
// it landed and at which client position), the fields' values, and the daemon's audit count
// (`browser status` inputs: CDP `Input.*` commands vs operating-system records): trusted events in the
// page while inputs.cdp stands still can only have come from the operating system.
// The real input runs on Windows only; every other platform must answer `unsupported` and touch nothing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OS_PASSWORD, OS_SPOT, OS_TITLE, OS_USER, startOsSite, type OsSite } from "./site.ts";
import { cliFor, rec, recs, s } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const WINDOWS = process.platform === "win32";
const SITE = "s82";
const S = ["--session", "os82"];

let home = "";
let site: OsSite;
let bundle = "";
const printed: string[] = [];
const { tabcap, ok } = cliFor(() => home, { onOutput: (out, err) => printed.push(out, err) });

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}[^"]*"[^\\n]*\\[((?:f\\d+/)*e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no ${role} "${name}" in:\n${tree}`);
  return m[1];
}

type Ev = { t: string; tr: boolean; where: string; id: string | null; code: string | null; key: string | null; shift: boolean; ctrl: boolean; x: number | null; y: number | null; detail: number };
const evalValue = async (expr: string): Promise<unknown> => (await ok("evaluate", expr, ...S))["value"];
const pageLog = async (): Promise<Ev[]> => JSON.parse(s(await evalValue("JSON.stringify(window.__s82)"))) as Ev[];
const clearLog = async (): Promise<void> => {
  await evalValue("window.__s82.length = 0");
};
const inputs = async (): Promise<{ cdp: number; os: number }> => {
  const i = rec((await ok("browser", "status"))["inputs"]);
  if (typeof i["cdp"] !== "number" || typeof i["os"] !== "number") throw new Error(`browser status has no inputs: ${JSON.stringify(i)}`);
  return { cdp: i["cdp"], os: i["os"] };
};

/** The real pointer of the Windows runner: read before the file, put back after it (later files must not find it over the page). */
function pointer(set?: string): string {
  const read = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $p = [System.Windows.Forms.Cursor]::Position; \"$($p.X),$($p.Y)\"";
  const write = (xy: string) => `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${xy}); "ok"`;
  const r = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", set === undefined ? read : write(set)], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return r.stdout.toString().trim();
}

let pointerBefore = "";

describe.skipIf(!enabled)("docs/16 --os input L2 (s82)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e12c-"));
    site = startOsSite();
    if (WINDOWS) pointerBefore = pointer();
    const add = await tabcap(["site", "add", SITE, "--url", `${site.origin}/s82`, "--user", OS_USER, "--password-stdin"], OS_PASSWORD + "\n");
    if (!add.ok) throw new Error(`site add failed: ${add.raw}`);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("session", "start", "os82", "--site", SITE);
    await ok("navigate", `${site.origin}/s82`, ...S);
    bundle = s((await ok("net", "start", ...S))["bundle"]);
    expect(await evalValue("document.title")).toBe(OS_TITLE);
  }, 60_000);

  afterAll(async () => {
    await tabcap(["daemon", "stop"]).catch(() => null);
    site.stop();
    if (WINDOWS && /^\d+,\d+$/.test(pointerBefore)) pointer(pointerBefore);
    removeHome(home, import.meta.file);
  });

  test("1. flags that do not fit together are usage errors before anything is sent (every platform)", async () => {
    const tree = s((await ok("snapshot", ...S))["tree"]);
    const user = refOf(tree, "textbox", "用户");
    const before = await inputs();
    for (const argv of [
      ["click", "--at", "5,5"],
      ["click", user, "--os", "--trusted"],
      ["click", user, "--os", "--at", "5,5"],
      ["click", user, "--os", "--dbl-click"],
      ["type", "--secret", `${SITE}.password`],
      ["type", "abc", "--os", "--secret", `${SITE}.password`],
      ["type", "abc", "--os", "--insert"],
      ["type", "abc", "--os-text", "--trusted"],
      ["type", "abc", "--os", "--delay", "99999"],
    ]) {
      const r = await tabcap([...argv, ...S]);
      expect([argv.join(" "), r.error?.["code"]]).toEqual([argv.join(" "), "usage"]);
    }
    expect((await tabcap(["click", "--os", ...S])).exit).toBe(2);
    expect((await tabcap(["type", "--os", ...S])).exit).toBe(2);
    expect(await inputs()).toEqual(before);
    expect(await pageLog()).toEqual([]);
  });

  test.skipIf(WINDOWS)("2. not Windows: every --os command answers `unsupported`, names the platform, and neither the page nor the counters move", async () => {
    const tree = s((await ok("snapshot", ...S))["tree"]);
    const user = refOf(tree, "textbox", "用户");
    const before = await inputs();
    for (const argv of [
      ["click", user, "--os"],
      ["click", "--os", "--at", `${OS_SPOT.at.x},${OS_SPOT.at.y}`],
      ["type", "abc", "--os"],
      ["type", "中文", "--os-text"],
      ["type", "--os", "--secret", `${SITE}.password`],
      ["press-key", "Enter", "--os"],
    ]) {
      const r = await tabcap([...argv, ...S]);
      expect([argv.join(" "), r.error?.["code"], r.error?.["platform"]]).toEqual([argv.join(" "), "unsupported", process.platform]);
      expect(s(r.error?.["next"])).toContain("--trusted");
    }
    expect(await inputs()).toEqual(before);
    expect(await pageLog()).toEqual([]);
    expect(await evalValue("document.getElementById('user').value + '|' + document.getElementById('pwd').value")).toBe("|");
    // the refused password did not count as this session's login attempt: a real fill still goes through
    const pwd = refOf(tree, "textbox", "密码");
    expect((await ok("fill", pwd, "--secret", `${SITE}.password`, ...S))["masked"]).toBe(true);
  });

  let layout = "";

  test.skipIf(!WINDOWS)("3. click <ref> --os: a trusted press on the element, focus follows, and no CDP input was used", async () => {
    const tree = s((await ok("snapshot", ...S))["tree"]);
    const user = refOf(tree, "textbox", "用户");
    const before = await inputs();
    const c = await ok("click", user, "--os", ...S);
    expect(c).toMatchObject({ input: "os", level: 3, trusted: true, eventShape: "os", ref: user });
    expect(rec(c["delivered"])["pointerdown"]).toBe(true);
    expect(typeof rec(c["foreground"])["taken"]).toBe("boolean");
    expect(typeof rec(c["foreground"])["restored"]).toBe("boolean");
    expect(Number(rec(c["pointer"])["moves"])).toBeGreaterThanOrEqual(2);
    const log = await pageLog();
    const down = log.filter((e) => e.t === "mousedown");
    expect(down.length).toBe(1);
    expect(down[0]).toMatchObject({ tr: true, where: "top", id: "user" });
    expect(log.filter((e) => e.t === "click").map((e) => [e.tr, e.id])).toEqual([[true, "user"]]);
    expect(await evalValue("document.activeElement.id")).toBe("user");
    const after = await inputs();
    expect(after.cdp).toBe(before.cdp);
    expect(after.os).toBeGreaterThan(before.os);
  });

  test.skipIf(!WINDOWS)("4. type --os: one real key per character, Shift for capitals, in order; press-key --os moves focus", async () => {
    await clearLog();
    const before = await inputs();
    const t = await ok("type", "abcXYZ19", "--os", "--delay", "30", ...S);
    expect(t).toMatchObject({ input: "os", eventShape: "os", keyMode: "scan", keys: 8, delayMs: 30, length: 8, masked: false });
    layout = s(t["layout"]);
    expect(layout).toMatch(/^[0-9a-f]{4}$/);
    expect(await evalValue("document.getElementById('user').value")).toBe("abcXYZ19");
    const downs = (await pageLog()).filter((e) => e.t === "keydown");
    expect(downs.every((e) => e.tr && e.id === "user")).toBe(true);
    expect(downs.map((e) => e.code)).toEqual(["KeyA", "KeyB", "KeyC", "ShiftLeft", "KeyX", "ShiftLeft", "KeyY", "ShiftLeft", "KeyZ", "Digit1", "Digit9"]);
    expect(downs.filter((e) => e.code?.startsWith("Key")).map((e) => e.shift)).toEqual([false, false, false, true, true, true]);
    const mid = await inputs();
    expect(mid.cdp).toBe(before.cdp);
    // 5 plain keys and 3 shifted ones: (5 + 3) * 2 key records and 3 * 2 for Shift
    expect(mid.os - before.os).toBe(22);
    const k = await ok("press-key", "Tab", "--os", ...S);
    expect(k).toMatchObject({ input: "os", eventShape: "os", key: "Tab" });
    expect(await evalValue("document.activeElement.id")).toBe("pwd");
    expect((await inputs()).cdp).toBe(before.cdp);
  });

  test.skipIf(!WINDOWS)("5. type --os --secret: the stored password goes in by keys, the output and the recording never show it; a second one needs --confirm", async () => {
    const at = printed.length;
    const t = await ok("type", "--os", "--secret", `${SITE}.password`, "--delay", "30", ...S);
    expect(t).toMatchObject({ input: "os", masked: true, secret: `${SITE}.password`, value: `<secret:${SITE}.password>`, length: OS_PASSWORD.length });
    // the page holds exactly the stored value: the daemon prints it as the reference
    expect(await evalValue("document.getElementById('pwd').value")).toBe(`<secret:${SITE}.password>`);
    expect(printed.slice(at).join("\n")).not.toContain(OS_PASSWORD);
    const again = await tabcap(["type", "--os", "--secret", `${SITE}.password`, ...S]);
    expect(again.error?.["code"]).toBe("guard.login-limit");
    expect(await evalValue("document.getElementById('pwd').value.length")).toBe(OS_PASSWORD.length);
  });

  test.skipIf(!WINDOWS)("6. a text the layout cannot type is refused whole; --os-text sends the characters themselves", async () => {
    const tree = s((await ok("snapshot", ...S))["tree"]);
    await ok("click", refOf(tree, "textbox", "用户"), "--os", ...S);
    expect(await evalValue("document.activeElement.id")).toBe("user");
    if (layout === "0409") {
      const before = await inputs();
      const bad = await tabcap(["type", "aü", "--os", ...S]);
      expect(bad.error?.["code"]).toBe("usage");
      expect(s(bad.error?.["message"])).toContain("character 2 (U+00fc)");
      expect((await inputs()).os).toBe(before.os);
      expect(await evalValue("document.getElementById('user').value")).toBe("abcXYZ19");
    }
    await ok("press-key", "Control+a", "--os", ...S);
    const t = await ok("type", "中文ü", "--os-text", "--delay", "20", ...S);
    expect(t).toMatchObject({ input: "os", keyMode: "unicode", keys: 3 });
    expect(await evalValue("document.getElementById('user').value")).toBe("中文ü");
    // a character outside the basic plane is two code units, sent one after the other
    await ok("press-key", "Control+a", "--os", ...S);
    expect(await ok("type", "😀", "--os-text", "--delay", "20", ...S)).toMatchObject({ keyMode: "unicode", keys: 2 });
    expect(await evalValue("document.getElementById('user').value")).toBe("😀");
  });

  test.skipIf(!WINDOWS)("7. click --os --at: the press lands on the viewport point; a point inside a frame or outside the viewport is refused", async () => {
    await clearLog();
    const c = await ok("click", "--os", "--at", `${OS_SPOT.at.x},${OS_SPOT.at.y}`, ...S);
    expect(c).toMatchObject({ input: "os", eventShape: "os", at: OS_SPOT.at });
    expect(rec(c["landedOn"])["tag"]).toBe("div");
    const down = (await pageLog()).filter((e) => e.t === "mousedown");
    expect(down.length).toBe(1);
    expect(down[0]).toMatchObject({ tr: true, id: "spot" });
    expect(Math.abs((down[0]?.x ?? -99) - OS_SPOT.at.x)).toBeLessThanOrEqual(2);
    expect(Math.abs((down[0]?.y ?? -99) - OS_SPOT.at.y)).toBeLessThanOrEqual(2);
    await clearLog();
    const inFrame = await tabcap(["click", "--os", "--at", "60,250", ...S]);
    expect(inFrame.error?.["code"]).toBe("unsupported");
    const outside = await tabcap(["click", "--os", "--at", "5000,5000", ...S]);
    expect(outside.error?.["code"]).toBe("usage");
    expect((await pageLog()).filter((e) => e.t === "mousedown")).toEqual([]);
  });

  test.skipIf(!WINDOWS)("8. click <frame ref> --os and a button: the press arrives in the frame's own document, and on the button once", async () => {
    await clearLog();
    const tree = s((await ok("snapshot", "--frames", ...S))["tree"]);
    const inner = refOf(tree, "button", "框内");
    expect(inner).toContain("/");
    const c = await ok("click", inner, "--os", ...S);
    expect(c).toMatchObject({ input: "os", ref: inner });
    expect(typeof c["frame"]).toBe("string");
    const go = refOf(tree, "button", "提交");
    await ok("click", go, "--os", ...S);
    const clicks = (await pageLog()).filter((e) => e.t === "click");
    expect(clicks.map((e) => [e.tr, e.where, e.id, e.detail])).toEqual([
      [true, "frame", "inner", 1],
      [true, "top", "go", 1],
    ]);
  });

  test.skipIf(!WINDOWS)("9. none of it was taken for the human: the session still runs; the recording has the commands and not the password", async () => {
    await Bun.sleep(800);
    expect((await ok("handoff", "status", ...S))["state"]).not.toBe("waiting");
    await ok("net", "stop", ...S);
    const events = readFileSync(join(bundle, "events.jsonl"), "utf8");
    expect(events).not.toContain(OS_PASSWORD);
    const raw = join(bundle, "raw", "cdp.jsonl");
    if (existsSync(raw)) expect(readFileSync(raw, "utf8")).not.toContain(OS_PASSWORD);
    const cmds = recs(events.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as unknown)).filter((e) => e["kind"] === "cmd" && e["phase"] === "start");
    const secretType = cmds.find((e) => rec(e["input"])["action"] === "type" && rec(e["input"])["secret"] === `${SITE}.password`);
    expect(rec(secretType?.["input"])).toMatchObject({ os: true, secret: `${SITE}.password` });
  });
});
