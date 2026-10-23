// L2 for 0.9-D: tabcap takes over the browser's downloads (docs/04 §48,
// docs/05 s75). Oracle: the range's own record of every attachment it served
// (the bytes sent, their sha256, whether the whole body went out) and the
// fixed contents of the page's blob: / data: downloads (S75_BLOB / S75_DATA,
// whose sha256 is written below). Every file name carries this run's tag; the
// user's ~/Downloads is only read, never written: a file of this run there is
// the 0.8.1 bug (Chrome for Testing saving into the user's own folder).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/shared/json.ts";
import { S75_BLOB, S75_DATA, startDownloadSite, type DownloadSite, type S75Served } from "./site.ts";
import { cliFor, rec, recs, s, until, type Env } from "./_cli.ts";
import { removeHome } from "./_daemon.ts";

const CHROME = process.env["TABCAP_CHROME"] ?? "";
const enabled = process.env["TABCAP_E2E"] === "1" && CHROME !== "";
const S = ["--session", "v09d"];
const TAG = `v09d${process.pid}x${Date.now() % 100_000}`;
/** sha256 of the page's fixed blob: and data: contents (oracle; checked against the constants below). */
const BLOB_SHA = "1c60a89e76960e27dce865fdf050acc257d7e8c3508fce8c066d4a440fadcc92";
const DATA_SHA = "dd3164e5aa7b362bf6d380c2cfb6510bc014491ea75f21d975d2bab154853ab1";

let home = "";
let site: DownloadSite;

const cli = cliFor(() => home);
const tabcap = (...args: string[]): Promise<Env> => cli.tabcap(args);
const { ok } = cli;

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** The files of this run in the user's ~/Downloads (read only). */
function inUserDownloads(): string[] {
  const dir = join(homedir(), "Downloads");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(TAG));
}

/** Every file under the browser run's staging directories (<home>/data/downloads/run-*). */
function staged(): string[] {
  const root = join(home, "data", "downloads");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((run) => {
    const dir = join(root, run);
    return statSync(dir).isDirectory() ? readdirSync(dir).map((f) => join(run, f)) : [];
  });
}

/** The range's one record of `path` (with `query`, when given) served after `from` records. */
function servedOf(path: string, from: number, query?: string): S75Served {
  const hits = site.served.slice(from).filter((x) => x.path === path && (query === undefined || x.query === query));
  if (hits.length !== 1) throw new Error(`${hits.length} serves of ${path}${query === undefined ? "" : `?${query}`}: ${JSON.stringify(site.served)}`);
  const hit = hits[0];
  if (hit === undefined) throw new Error("unreachable");
  return hit;
}

/** Events of a bundle on disk (the writer flushes every 100 ms; finished bundles are complete). */
function events(bundle: string): Record<string, unknown>[] {
  return readFileSync(join(bundle, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l): Record<string, unknown>[] => {
      try {
        const v: unknown = JSON.parse(l);
        return isRecord(v) ? [v] : [];
      } catch {
        return [];
      }
    });
}

const refOf = (tree: string, name: string): string => {
  const m = new RegExp(`link "${name}" \\[(e\\d+)\\]`).exec(tree);
  if (m?.[1] === undefined) throw new Error(`no link "${name}" in:\n${tree}`);
  return m[1];
};

/** The /s75 page's link refs in a session's current tab. */
async function links(session: string[]): Promise<Record<"file" | "adl" | "blob" | "data" | "big" | "big64", string>> {
  const tree = s((await ok("snapshot", "--interactive", ...session))["tree"]);
  return { file: refOf(tree, "attachment"), adl: refOf(tree, "a download"), blob: refOf(tree, "blob"), data: refOf(tree, "data"), big: refOf(tree, "big 8"), big64: refOf(tree, "big 64") };
}

describe.skipIf(!enabled)("tabcap 0.9-D L2 (s75 downloads)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "tabcap-e2e09d-"));
    site = startDownloadSite(TAG);
    await ok("daemon", "start");
    await ok("browser", "start", "--proxy", "none", "--executable-path", CHROME);
    await ok("navigate", `${site.origin}/s75`, ...S);
  }, 90_000);

  afterAll(async () => {
    await tabcap("daemon", "stop").catch(() => null);
    site.stop();
    removeHome(home, import.meta.file, { bundles: true });
  });

  test("the blob: / data: oracle hashes are the page's fixed contents", () => {
    expect(sha(S75_BLOB)).toBe(BLOB_SHA);
    expect(sha(S75_DATA)).toBe(DATA_SHA);
  });

  test("1 / 3a. not recording: a clicked attachment and a navigation to one are canceled, the answers say so, no file stays anywhere", async () => {
    const l = await links(S);
    const click = await ok("click", l.file, ...S);
    expect(recs(click["downloads"])).toEqual([{ url: `${site.origin}/s75/file`, suggestedFilename: `s75-${TAG}.txt`, state: "canceled", reason: "not-recording" }]);
    expect(s(click["next"])).toContain("tabcap net start");

    const nav = await ok("navigate", `${site.origin}/s75/nav`, ...S);
    expect(rec(nav["download"])).toEqual({ url: `${site.origin}/s75/nav`, suggestedFilename: `s75-${TAG}-nav.bin`, state: "canceled", reason: "not-recording" });
    expect(nav["note"]).toBe("the URL is a file download; the page did not change");
    expect(s(nav["next"])).toContain("tabcap net start");
    expect(nav["url"]).toBe(`${site.origin}/s75`);
    // navigate's own `download` says it; the generic list does not repeat it
    expect(nav["downloads"]).toBeUndefined();

    // Chrome removes a canceled part; tabcap removes a file Chrome had already finished.
    await until("an empty staging directory", () => staged(), (f) => f.length === 0, 10_000);
    expect(existsSync(join(home, "data", "bundles"))).toBe(false);
    expect(inUserDownloads()).toEqual([]);
  }, 60_000);

  test("2. recording: the four triggers (JS clicks, no user gesture) each end completed, their files are what the range / page sent, the event's cmd is the click's", async () => {
    const started = await ok("net", "start", ...S);
    const bundle = s(started["bundle"]);
    const l = await links(S);
    const from = site.served.length;
    const want = [
      { ref: l.file, name: `s75-${TAG}.txt`, url: `${site.origin}/s75/file`, sha: () => servedOf("/s75/file", from).sha256 },
      { ref: l.adl, name: `s75-${TAG}-plain.txt`, url: `${site.origin}/s75/plain`, sha: () => servedOf("/s75/plain", from).sha256 },
      { ref: l.blob, name: `s75-${TAG}-blob.txt`, url: "blob:", sha: () => BLOB_SHA },
      { ref: l.data, name: `s75-${TAG}-data.txt`, url: "data:text/plain,s75%20data%20body", sha: () => DATA_SHA },
    ];
    const cmds: string[] = [];
    for (const w of want) {
      const click = await ok("click", w.ref, ...S);
      expect(click["downloads"]).toBeUndefined();
      cmds.push(s(click["cmd"]));
      const got = await ok("download", "wait", "--timeout", "20000", ...S);
      expect(got).toMatchObject({ state: "completed", reason: null, suggestedFilename: w.name, tab: "t1", alreadyFinished: expect.any(Boolean) });
      expect(s(got["url"]).startsWith(w.url)).toBe(true);
      const file = s(got["file"]);
      expect(file.startsWith(join(bundle, "downloads"))).toBe(true);
      const bytes = new Uint8Array(readFileSync(file));
      expect(sha(bytes)).toBe(w.sha());
      expect(got["sha256"]).toBe(w.sha());
      expect(got["bytes"]).toBe(bytes.length);
      // POSIX permission bits; Windows reports 666 / 777 (other tests guard them the same way)
      if (process.platform !== "win32") expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    }
    if (process.platform !== "win32") expect((statSync(join(bundle, "downloads")).mode & 0o777).toString(8)).toBe("700");
    const list = await ok("download", "list", ...S);
    expect(list).toMatchObject({ recording: true, total: 4 });
    expect(recs(list["downloads"]).map((x) => [x["suggestedFilename"], x["state"], x["tab"]])).toEqual(want.map((w) => [w.name, "completed", "t1"]));
    await until("four download events", () => events(bundle).filter((e) => e["kind"] === "download"), (x) => x.length === 4, 5000);
    const evs = events(bundle).filter((e) => e["kind"] === "download");
    expect(evs.map((e) => e["cmd"])).toEqual(cmds);
    for (const e of evs) {
      expect(e["id"]).toBe(`d-${String(e["seq"])}`);
      expect(e).toMatchObject({ tab: "t1", state: "completed", reason: null, actor: "ai" });
      expect(s(e["file"])).toBe(`downloads/${s(e["sha256"])}`);
      expect(typeof e["startedTs"]).toBe("number");
      expect(typeof e["guid"]).toBe("string");
    }
    expect(inUserDownloads()).toEqual([]);
  }, 120_000);

  test("3b / 4. recording: navigate to an attachment answers the unchanged page with download; an 8 MiB slow attachment completes with the range's bytes", async () => {
    const from = site.served.length;
    const nav = await ok("navigate", `${site.origin}/s75/nav`, ...S);
    expect(["in-progress", "completed"]).toContain(s(rec(nav["download"])["state"]));
    expect(rec(nav["download"])).toMatchObject({ url: `${site.origin}/s75/nav`, suggestedFilename: `s75-${TAG}-nav.bin` });
    expect(nav["note"]).toBe("the URL is a file download; the page did not change");
    expect(nav["next"]).toBeUndefined();
    expect(nav["url"]).toBe(`${site.origin}/s75`);
    expect(nav["status"]).toBe(200);
    const tabs = recs((await ok("tab", "list", ...S))["tabs"]);
    expect(tabs.map((x) => x["url"])).toEqual([`${site.origin}/s75`]);
    const got = await ok("download", "wait", "--url", "/s75/nav", "--timeout", "20000", ...S);
    expect(got).toMatchObject({ state: "completed", sha256: servedOf("/s75/nav", from).sha256 });

    const l = await links(S);
    await ok("click", l.big, ...S);
    const big = await ok("download", "wait", "--url", "/s75/big", "--timeout", "60000", ...S);
    const served = servedOf("/s75/big", from, "mb=8");
    expect(served.complete).toBe(true);
    expect(big).toMatchObject({ state: "completed", bytes: 8 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, sha256: served.sha256 });
    expect(sha(new Uint8Array(readFileSync(s(big["file"]))))).toBe(served.sha256);
  }, 120_000);

  test("6 / 7. a download still running at net stop is canceled (stopped, no file); bundle redact leaves downloads/ out and nulls file", async () => {
    const l = await links(S);
    const from = site.served.length;
    await ok("click", l.big64, ...S);
    // it began: the range is sending it
    await until("the 64 MiB attachment to be in progress", async () => recs((await ok("download", "list", ...S))["downloads"]).filter((x) => x["state"] === "in-progress"), (x) => x.length === 1, 10_000);
    const stopped = await ok("net", "stop", ...S);
    const bundle = s(stopped["bundle"]);
    const evs = events(bundle).filter((e) => e["kind"] === "download");
    const big64 = evs.filter((e) => s(e["url"]).includes("mb=64"));
    expect(big64.length).toBe(1);
    expect(big64[0]).toMatchObject({ state: "canceled", reason: "stopped", file: null, sha256: null });
    expect(rec(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"))["counts"])["downloads"]).toBe(evs.length);
    await until("the range to see the 64 MiB download go away", () => servedOf("/s75/big", from, "mb=64"), (x) => !x.complete, 10_000);
    const list = await ok("download", "list", ...S);
    expect(list["recording"]).toBe(false);
    expect(recs(list["downloads"]).some((x) => x["state"] === "in-progress")).toBe(false);
    await until("an empty staging directory", () => staged(), (f) => f.length === 0, 10_000);

    // 7. the redacted copy
    const copy = join(home, "redacted-v09d");
    await ok("bundle", "redact", bundle, copy);
    expect(existsSync(join(bundle, "downloads"))).toBe(true);
    expect(existsSync(join(copy, "downloads"))).toBe(false);
    const red = events(copy).filter((e) => e["kind"] === "download");
    expect(red.length).toBe(evs.length);
    for (const e of red) expect(e).toMatchObject({ file: null, redacted: true });
    expect(red.map((e) => e["sha256"])).toEqual(evs.map((e) => e["sha256"]));
    expect(inUserDownloads()).toEqual([]);
  }, 120_000);

  test("5. a pool account's session (its own browser context) keeps its download while recording", async () => {
    const SITE = "example";
    const added = await cli.tabcap(["site", "add", SITE, "--url", `${site.origin}/s75`, "--user", "alice", "--password-stdin"], "Site-pass-e2e-9d01\n");
    if (!added.ok) throw new Error(`site add failed: ${added.raw}`);
    const P = ["--session", "p"];
    const started = await ok("session", "start", "p", "--site", SITE, "--account", "alice");
    expect(started).toMatchObject({ account: "alice", browserContext: "own" });
    await ok("navigate", `${site.origin}/s75`, ...P);
    const rp = await ok("net", "start", ...P);
    const l = await links(P);
    const from = site.served.length;
    await ok("click", l.file, ...P);
    const got = await ok("download", "wait", "--timeout", "20000", ...P);
    expect(got).toMatchObject({ state: "completed", suggestedFilename: `s75-${TAG}.txt`, sha256: servedOf("/s75/file", from).sha256 });
    expect(s(got["file"]).startsWith(s(rp["bundle"]))).toBe(true);
    await ok("session", "stop", "p");
    expect(inUserDownloads()).toEqual([]);
  }, 120_000);

  test("browser stop removes the staging directory", async () => {
    await ok("browser", "stop");
    const root = join(home, "data", "downloads");
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  }, 60_000);
});
