// L2 for 0.3-E: input fidelity on the s46 probe page (docs/05 s46, docs/06
// A7.1–A7.10, owner decisions 10-15) and docs/04 §5.2 rule 9 (unreadByPage).
// Expected values come from the page's own event report and from the
// Playwright exports in fixtures/probe/oracle/ (scripts/probe-oracle.mjs),
// never from tabcap's output. Only the local range sites are opened.
// The field-by-field diff against Playwright (A7.6) is printed, not asserted
// beyond the structure fields the acceptance names.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { clickRhythm, clickSegment, collapseMoves, diffEvents, formatDiff, RHYTHM_FIELDS, typingSegment, type Ev } from "./eventshape.ts";
import { LOGIN_PASSWORD, LOGIN_USER, startGuardSite, startProbeSite, type GuardSite, type ProbeSite } from "./site.ts";
import { cliFor, rec, recs, s, until as poll, type Env } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const ORACLE_DIR = join(import.meta.dir, "..", "..", "fixtures", "probe", "oracle");
const TEXT = "aB3 中";

let home = "";
let probe: ProbeSite;
let guard: GuardSite;
/** Every byte any tabcap command printed (stdout and stderr), for A7.10. */
const printed: string[] = [];

/**
 * 0.7.3: a trusted click on a navigating link succeeds either way; which proof it carries depends on
 * whether the navigation committed before the delivery probe was read (then the probe is lost and
 * the tab's navigation record stands in) or after it (the probe reports the press as usual).
 */
function deliveredOrNavigated(c: Record<string, unknown>): void {
  const d = rec(c["delivered"]);
  if (d["reason"] === "navigated") expect(d).toMatchObject({ pointerdown: "unknown", mousedown: "unknown" });
  else expect(d).toMatchObject({ pointerdown: true, mousedown: true });
}

const cli = cliFor(() => home, { onOutput: (out, err) => printed.push(out, err) });
const tabcap = (...args: string[]): Promise<Env> => cli.tabcap(args);
const { ok } = cli;

/** until(), polling every 100 ms. */
const until = <T>(what: string, f: () => Promise<T> | T, good: (v: T) => boolean, ms = 15_000): Promise<T> => poll(what, f, good, ms, 100);

function oracle(mode: string): Ev[] {
  const f = readdirSync(ORACLE_DIR).find((n) => n.endsWith(`-${mode}.json`));
  if (f === undefined) throw new Error(`no oracle export for ${mode}`);
  return recs(rec(rec(JSON.parse(readFileSync(join(ORACLE_DIR, f), "utf8")))["report"])["events"]);
}

/** The page's own report for `run` (posted to /report). */
async function report(run: string): Promise<Record<string, unknown>> {
  return until(`the probe report ${run}`, () => probe.reports.get(run) ?? null, (v) => v !== null).then((v) => v ?? {});
}

/** The clickable ref of a find hit. */
async function refOf(text: string, session: string[]): Promise<string> {
  const h = recs((await ok("find", text, ...session))["hits"]).find((x) => x["clickable"] !== null || x["ref"] !== null);
  if (h === undefined) throw new Error(`no hit for ${text}`);
  return s(h["clickable"] ?? h["ref"]);
}

const pick = (e: Ev | undefined, keys: string[]) => Object.fromEntries(keys.map((k) => [k, e?.[k] ?? null]));
const POINTER_FIELDS = ["button", "buttons", "pressure", "pointerType", "isPrimary", "width", "height", "detail"];

describe.skipIf(!enabled)("tabcap 0.3-E L2 (input fidelity on s46, unreadByPage)", () => {
  const P = ["--session", "s46"];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e3e-"));
    probe = startProbeSite();
    guard = startGuardSite();
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
  }, 60_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    probe.stop();
    guard.stop();
    removeHome(home, import.meta.file);
  });

  test("A7.4: the default click stays the DOM click — one untrusted click like the Playwright el.click() export, marked eventShape incomplete", async () => {
    await ok("navigate", `${probe.origin}/probe?run=tc-dom`, ...P);
    const c = await ok("click", await refOf("默认框", P), ...P);
    expect(c).toMatchObject({ level: 1, trusted: false, eventShape: "incomplete" });
    expect(s(c["warning"])).toContain("incomplete event sequence");
    const evs = recs((await report("tc-dom"))["events"]);
    const want = oracle("js_click");
    expect(evs.map((e) => [e["type"], e["isTrusted"], e["detail"], e["clientX"], e["clientY"]])).toEqual(want.map((e) => [e["type"], e["isTrusted"], e["detail"], e["clientX"], e["clientY"]]));
    console.log(formatDiff("A7.4 default click vs Playwright evaluate(el.click())", diffEvents(evs, want)));
  }, 60_000);

  test("A7.1 / A7.6: click --trusted — moves before pointerdown ending within 1 px of the target, all trusted, pointer fields of the Playwright export", async () => {
    await ok("navigate", `${probe.origin}/probe?run=tc-trusted`, ...P);
    const c = await ok("click", await refOf("默认框", P), "--trusted", ...P);
    expect(c).toMatchObject({ level: 2, trusted: true, eventShape: "full", delivered: { pointerdown: true, mousedown: true } });
    const traj = rec(c["trajectory"]);
    expect(Number(traj["points"])).toBeGreaterThanOrEqual(3);
    expect(Number(traj["plannedMs"])).toBeGreaterThanOrEqual(100);
    expect(Number(traj["plannedMs"])).toBeLessThanOrEqual(400);
    expect(Number(c["pressGapMs"])).toBeGreaterThanOrEqual(50);
    expect(Number(c["pressGapMs"])).toBeLessThanOrEqual(140);
    const r = await report("tc-trusted");
    const evs = recs(r["events"]);
    const rhythm = clickRhythm(evs);
    expect(rhythm.pointerMovesBeforeDown).toBeGreaterThanOrEqual(1);
    expect(rhythm.endGapPx).not.toBeNull();
    expect(rhythm.endGapPx ?? 99).toBeLessThanOrEqual(1);
    expect(rhythm.allTrusted).toBe(true);
    // the last move lands on the target's centre as the page measures it
    const target = rec(r["target"]);
    const lastMove = evs.filter((e, i) => e["type"] === "pointermove" && i < evs.findIndex((x) => x["type"] === "pointerdown")).at(-1);
    expect(Math.hypot(Number(lastMove?.["clientX"]) - Number(target["x"]), Number(lastMove?.["clientY"]) - Number(target["y"]))).toBeLessThanOrEqual(1);
    // on the target, after collapsing the path: Playwright's structure
    const want = oracle("click");
    const seg = collapseMoves(clickSegment(evs) ?? []);
    expect(seg.map((e) => e["type"])).toEqual(want.map((e) => e["type"]));
    for (const type of ["pointerdown", "pointerup", "click"]) {
      expect([type, pick(seg.find((e) => e["type"] === type), POINTER_FIELDS)]).toEqual([type, pick(want.find((e) => e["type"] === type), POINTER_FIELDS)]);
    }
    // A7.6: the report — structure fields one by one, rhythm listed
    console.log(formatDiff("A7.6 click --trusted (on-target segment, path collapsed) vs Playwright page.click (headless)", diffEvents(seg, want)));
    console.log(`A7.6 rhythm tabcap: ${JSON.stringify(rhythm)} plan=${JSON.stringify({ trajectory: traj, pressGapMs: c["pressGapMs"] })}`);
    console.log(`A7.6 rhythm playwright: ${JSON.stringify(clickRhythm(want))}`);
    console.log(`A7.6 path before the target: ${evs.slice(0, evs.indexOf(clickSegment(evs)?.[0] ?? {})).map((e) => `${s(e["type"])}@${s(e["target"])}`).join(" ")}`);
  }, 60_000);

  test("A7.5: type --trusted gives the Playwright type() key sequence; --insert and the default give the fill() shape, marked", async () => {
    await ok("navigate", `${probe.origin}/probe?run=tc-type`, ...P);
    await ok("click", await refOf("type here", P), "--trusted", ...P);
    const t = await ok("type", TEXT, "--trusted", ...P);
    expect(t).toMatchObject({ eventShape: "keys", keys: 4, inserted: 1, delayMs: 0, length: TEXT.length });
    await ok("evaluate", "window.__probeReport().then(() => true)", "--await", ...P);
    const r = await report("tc-type");
    expect(r["field"]).toBe(TEXT);
    const ours = typingSegment(recs(r["events"]));
    const want = typingSegment(oracle("type"));
    const d = diffEvents(ours, want, [...RHYTHM_FIELDS]);
    console.log(formatDiff("A7.5 type --trusted vs Playwright page.type (headless)", d));
    expect(d.types.equal).toBe(true);
    expect(d.fields).toEqual([]);

    for (const [run, flags] of [["tc-insert", ["--insert"]], ["tc-insert-default", []]] as const) {
      await ok("navigate", `${probe.origin}/probe?run=${run}`, ...P);
      await ok("click", await refOf("type here", P), "--trusted", ...P);
      const i = await ok("type", TEXT, ...flags, ...P);
      expect(i).toMatchObject({ eventShape: "insert" });
      expect(s(i["warning"])).toContain("incomplete event sequence");
      await ok("evaluate", "window.__probeReport().then(() => true)", "--await", ...P);
      const di = diffEvents(typingSegment(recs((await report(run))["events"])), typingSegment(oracle("fill")));
      if (run === "tc-insert") console.log(formatDiff("A7.5 type --insert vs Playwright fill() (headless)", di));
      expect(di.fields).toEqual([]);
    }
    expect((await tabcap("type", "x", "--trusted", "--insert", ...P)).error?.["code"]).toBe("usage");
    expect((await tabcap("type", "x", "--delay", "10", ...P)).error?.["code"]).toBe("usage");
  }, 90_000);

  test("A7.3: click --trusted on a hidden background tab returns in time — delivered with the full shape, or degraded to the DOM click with the marker", async () => {
    const before = Date.now();
    await ok("navigate", `${probe.origin}/probe?run=tc-hidden`, "--new-tab", ...P);
    expect((await ok("evaluate", "document.visibilityState", ...P))["value"]).toBe("hidden");
    const c = await ok("click", await refOf("默认框", P), "--trusted", "--timeout", "15000", ...P);
    expect(Date.now() - before).toBeLessThan(20_000);
    const r = await report("tc-hidden");
    const evs = recs(r["events"]);
    if (c["eventShape"] === "full") {
      const rhythm = clickRhythm(evs);
      expect(rhythm.pointerMovesBeforeDown).toBeGreaterThanOrEqual(1);
      expect(rhythm.endGapPx ?? 99).toBeLessThanOrEqual(1);
      expect(rhythm.allTrusted).toBe(true);
    } else {
      expect(c).toMatchObject({ level: 1, eventShape: "incomplete", degraded: "not-painted" });
      expect(s(c["warning"])).toContain("incomplete event sequence");
      expect(evs.filter((e) => e["type"] === "pointermove" || e["type"] === "mousemove")).toEqual([]);
    }
    const down = evs.find((e) => e["type"] === "pointerdown" || e["type"] === "click");
    console.log(`A7.3 hidden tab: eventShape=${s(c["eventShape"])} degraded=${s(c["degraded"] ?? null)} visibility at press=${s(down?.["visibilityState"])} hasFocus=${s(down?.["hasFocus"])} tookMs=${Date.now() - before}`);
    expect((await ok("evaluate", "document.visibilityState", ...P))["value"]).toBe("hidden"); // emulation is off again
  }, 60_000);

  test("A7.10: a password typed key by key never shows up in the daemon log, CLI output or bundle — not even reassembled from single characters", async () => {
    const S = ["--session", "a710"];
    const bundle = s((await ok("net", "start", ...S))["bundle"]);
    await ok("navigate", `${guard.origin}/s07/login`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    const ref = (name: string) => {
      const m = new RegExp(`"${name}[^"]*"[^\\n]*\\[(e\\d+)\\]`).exec(tree);
      if (m?.[1] === undefined) throw new Error(`no ${name} in ${tree}`);
      return m[1];
    };
    await ok("click", ref("用户名"), "--trusted", ...S);
    await ok("type", LOGIN_USER, "--trusted", ...S);
    await ok("click", ref("密码"), "--trusted", ...S);
    const t = await ok("type", LOGIN_PASSWORD, "--trusted", ...S);
    expect(t).toMatchObject({ masked: true, eventShape: "keys" });
    await ok("click", ref("登录"), ...S);
    await ok("wait", "--text", "data-ok", ...S);
    expect(new URLSearchParams(guard.loginBodies.at(-1) ?? "").get("password")).toBe(LOGIN_PASSWORD); // the page really got it
    await ok("net", "stop", ...S);

    const holds = (text: string) => text.includes(LOGIN_PASSWORD) || text.includes(JSON.stringify(LOGIN_PASSWORD).slice(1, -1)) || text.includes(encodeURIComponent(LOGIN_PASSWORD));
    /** Single-character JSON strings in order, joined: what a per-key log would spell. */
    const spelled = (text: string) => [...text.matchAll(/"((?:\\u[0-9a-fA-F]{4})|[^"\\]|\\.)"/g)].map((m) => { try { const v: unknown = JSON.parse(`"${m[1] ?? ""}"`); return typeof v === "string" ? v : ""; } catch { return ""; } }).join("");
    const log = readFileSync(join(home, "config", "daemon.log"), "utf8");
    expect(holds(log)).toBe(false);
    expect(spelled(log).includes(LOGIN_PASSWORD)).toBe(false);
    expect(printed.filter(holds)).toEqual([]);
    expect(spelled(printed.join("\n")).includes(LOGIN_PASSWORD)).toBe(false);
    // bundle: only the login POST (its request event and its raw CDP lines) carries it
    const offenders: string[] = [];
    for (const line of readFileSync(join(bundle, "events.jsonl"), "utf8").split("\n")) {
      if (line === "") continue;
      const e: unknown = JSON.parse(line);
      const isLogin = isRecord(e) && e["kind"] === "request" && s(e["url"]).endsWith("/api/login");
      if (!isLogin && (holds(line) || spelled(line).includes(LOGIN_PASSWORD))) offenders.push(line.slice(0, 200));
    }
    for (const line of readFileSync(join(bundle, "raw", "cdp.jsonl"), "utf8").split("\n")) if (!line.includes("/api/login") && holds(line)) offenders.push(`raw: ${line.slice(0, 200)}`);
    expect(offenders).toEqual([]);
  }, 90_000);

  test("0.7.3: click --trusted on an in-site link survives the lost delivery probe (navigation committed); --dbl-click on a button is unaffected", async () => {
    await ok("navigate", `${probe.origin}/link`, ...P);
    const link = await refOf("下一頁", P);
    const c = await ok("click", link, "--trusted", ...P);
    expect(c).toMatchObject({ level: 2, trusted: true, eventShape: "full", effect: "navigation" });
    deliveredOrNavigated(c);
    expect(s(c["url"])).toBe(`${probe.origin}/second`);
    expect(probe.hits).toContain("GET /second");

    // --no-wait: still a success, no effect claimed (the normal click's --no-wait rule); the
    // navigation may or may not have committed when the command answers, so wait for it after.
    await ok("navigate", `${probe.origin}/link`, ...P);
    const nw = await ok("click", await refOf("下一頁", P), "--trusted", "--no-wait", ...P);
    expect(nw).toMatchObject({ trusted: true, eventShape: "full" });
    deliveredOrNavigated(nw);
    expect(nw["effect"]).toBeUndefined();
    await ok("wait", "--url", "/second", ...P);

    // A double click on a plain button neither navigates nor changes the delivery proof.
    await ok("navigate", `${probe.origin}/link`, ...P);
    const plain = await refOf("普通按钮", P);
    const dbl = await ok("click", plain, "--trusted", "--dbl-click", ...P);
    expect(dbl).toMatchObject({ trusted: true, eventShape: "full", dblClick: true, delivered: { pointerdown: true, mousedown: true } });
    expect(s(dbl["url"])).toBe(`${probe.origin}/link`);
    expect(Number((await ok("evaluate", "window.__plain", ...P))["value"])).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("docs/04 §5.2 rule 9: a fetch whose body the page never reads is in net list while recording — finished, unreadByPage, body from Fetch, end null", async () => {
    const S = ["--session", "unread"];
    await ok("net", "start", ...S);
    await ok("navigate", `${guard.origin}/s15/?bucket=unread`, ...S);
    const tree = s((await ok("snapshot", "--interactive", ...S))["tree"]);
    const load = /button "加载" \[(e\d+)\]/.exec(tree)?.[1] ?? "";
    await ok("click", load, ...S);
    await ok("wait", "--text", "loaded 1", ...S);
    const rows = await until(
      "the unread /api/limited row",
      async () => recs((await ok("net", "list", "--filter", "/api/limited", ...S))["requests"]),
      (r) => r.some((x) => x["unreadByPage"] === true),
      6000,
    );
    const row = rows.find((x) => x["unreadByPage"] === true) ?? {};
    expect(row).toMatchObject({ outcome: "finished", status: 200 });
    const show = await ok("net", "show", s(row["id"]), ...S);
    expect(show).toMatchObject({ outcome: "finished", bodySource: "fetch", unreadByPage: true });
    expect(rec(rec(show["response"])["body"])["blob"]).not.toBeNull();
    expect(rec(show["timing"])["end"]).toBeNull();
    expect(await ok("net", "wait", "--url", "/api/limited", ...S)).toMatchObject({ status: 200 });
    await ok("net", "stop", ...S);
  }, 60_000);

  test("daemon stop leaves no browser", async () => {
    await ok("daemon", "stop");
    let left = "";
    for (let i = 0; i < 50; i++) {
      left = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((l) => l.includes("Chrome for Testing") && l.includes(home)).join("\n").trim();
      if (left === "") break;
      await Bun.sleep(100);
    }
    expect(left).toBe("");
  }, 30_000);
});
