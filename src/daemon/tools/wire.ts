// tabcap wire profile (docs/07 §6). Starts a local echo (src/wire/echo.ts)
// on 127.0.0.1 for the duration of the command.
//
// profile: opens a background tab in the session (the Chrome for Testing
// tabcap launched, with its own flags), ignores certificate errors on that
// tab only (Security.setIgnoreCertificateErrors), navigates to
// https://localhost:<port>/ and runs a page fetch("/fetch") N times each,
// closes the tab, and builds the profile with the component's `profile`
// (navigation and fetch as two header-order roles). Cached under
// <cache>/wire/profiles/ with the reports in a .samples directory.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_VERSION } from "../../bundle/manifest.ts";
import { TabcapError } from "../../shared/envelope.ts";
import { isRecord } from "../../shared/json.ts";
import { Echo, type EchoReport } from "../../wire/echo.ts";
import { Wireprint } from "../../wire/native.ts";
import { cftVersion, flagsSha256, normalizedFlags, profileArch, profileArgs, profileFile, profileOs, type TabcapSection } from "../../wire/profile.ts";
import type { Daemon } from "../state.ts";
import { checkSessionName, optNum, type Args } from "./args.ts";
import { timeoutOf, waitNavigation } from "./navigate.ts";

const DEFAULT_SAMPLES = 3;

type Baseline = { file: string; profile: Record<string, unknown>; navReport: Record<string, unknown>; section: TabcapSection; cached: boolean };

function samplesOf(a: Args): number {
  const n = optNum(a, "samples") ?? DEFAULT_SAMPLES;
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new TabcapError("usage", `--samples ${n}?`, "Use 1-20 samples (2 or more judge whether the extension order is random).");
  return n;
}

function portOf(a: Args): number {
  const p = optNum(a, "port") ?? 0;
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new TabcapError("usage", `bad --port ${p}`, "Pass 0-65535 (0 = any free port).");
  return p;
}

function browserFacts(d: Daemon): { version: string; flags: string[]; hash: string } {
  const { t, info } = d.need();
  const version = cftVersion(info.version);
  if (version === null) throw new TabcapError("unsupported", `cannot read the browser version from "${info.version}"`, "The baseline needs the Chrome for Testing tabcap launched (`tabcap browser start`).");
  const flags = normalizedFlags(t.args);
  return { version, flags, hash: flagsSha256(flags) };
}

const pathOf = (r: EchoReport): string => (isRecord(r["echo"]) && typeof r["echo"]["path"] === "string" ? r["echo"]["path"] : "");

/** Navigate + fetch `samples` times in a fresh background tab of the session; returns the echo's reports. */
async function captureSamples(d: Daemon, session: string, echo: Echo, samples: number, budgetMs: number): Promise<{ navigation: EchoReport[]; fetch: EchoReport[] }> {
  const { t, tabs } = d.need();
  checkSessionName(session);
  const prev = tabs.ensureSession(session).session.current;
  const tab = await tabs.createTab(session, { background: true });
  const out = { navigation: [] as EchoReport[], fetch: [] as EchoReport[] };
  try {
    // This tab only: the echo's certificate is not trusted by the browser, and nothing is installed.
    await t.send("Security.setIgnoreCertificateErrors", { ignore: true }, tab.sessionId);
    for (let i = 1; i <= samples; i++) {
      const navPath = `/?sample=${i}`;
      const url = echo.url(navPath);
      await tabs.run(
        tab,
        () =>
          waitNavigation(t, tab, url, budgetMs, async () => {
            const r = await t.send("Page.navigate", { url }, tab.sessionId);
            const err = typeof r["errorText"] === "string" ? r["errorText"] : "";
            if (err !== "") throw new TabcapError("page", `navigation to the wire echo failed: ${err}`, "Check that nothing blocks https://localhost (loopback) in this session's proxy settings.");
            return { loaderId: typeof r["loaderId"] === "string" ? r["loaderId"] : null, sameDocument: false };
          }, () => d.navOf(tab)),
        { timeoutMs: budgetMs, navigation: true },
      );
      out.navigation.push(await echo.waitFor((r) => r["role"] === "navigation" && pathOf(r) === navPath, 15_000, `navigation report ${i}`));
      const fetchPath = `/fetch?sample=${i}`;
      await tabs.run(tab, () => t.send("Runtime.evaluate", { expression: `fetch(${JSON.stringify(fetchPath)}).then((r) => r.status)`, awaitPromise: true, returnByValue: true }, tab.sessionId, 15_000), { timeoutMs: budgetMs });
      out.fetch.push(await echo.waitFor((r) => r["role"] === "fetch" && pathOf(r) === fetchPath, 15_000, `fetch report ${i}`));
    }
  } finally {
    await tabs.closeTab(tab);
    const s = tabs.session(session);
    if (s !== undefined && prev !== null && s.current === null && s.tabs.includes(prev)) s.current = prev;
  }
  return out;
}

const pskCount = (rs: EchoReport[]): number => rs.filter((r) => isRecord(r["echo"]) && r["echo"]["psk"] === true).length;

async function captureBaseline(d: Daemon, session: string, wp: Wireprint, echo: Echo, samples: number, budgetMs: number): Promise<Baseline> {
  const facts = browserFacts(d);
  const loc = profileFile(d.paths.cache, facts.version);
  const got = await captureSamples(d, session, echo, samples, budgetMs);
  rmSync(loc.samples, { recursive: true, force: true });
  mkdirSync(loc.samples, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const [role, list] of [["nav", got.navigation], ["fetch", got.fetch]] as const) {
    list.forEach((r, i) => {
      const f = join(loc.samples, `${role}-${i + 1}.json`);
      writeFileSync(f, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
      files.push(f);
    });
  }
  const capturedAt = new Date().toISOString();
  const { value } = await wp.json(profileArgs({ version: facts.version, os: profileOs(), arch: profileArch(), capturedAt, tabcapVersion: TOOL_VERSION, reports: files }));
  const section: TabcapSection = {
    cftVersion: facts.version,
    flagsSha256: facts.hash,
    flags: facts.flags,
    tabcapVersion: TOOL_VERSION,
    capturedAt,
    samples: { navigation: got.navigation.length, fetch: got.fetch.length },
    psk: { navigation: pskCount(got.navigation), fetch: pskCount(got.fetch) },
    sessionTickets: "disabled",
  };
  const profile = { ...value, tabcap: section };
  mkdirSync(join(loc.file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(loc.file, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  const nav = got.navigation[0];
  if (nav === undefined) throw new TabcapError("internal", "no navigation sample was captured", "This is a bug.");
  return { file: loc.file, profile, navReport: nav, section, cached: false };
}

export async function wireProfile(d: Daemon, a: Args, session: string): Promise<unknown> {
  const samples = samplesOf(a);
  const budget = timeoutOf(a);
  d.need();
  const wp = await Wireprint.locate({ cacheDir: d.paths.cache });
  const echo = await Echo.start({ wireprint: wp, port: portOf(a) });
  try {
    const b = await captureBaseline(d, session, wp, echo, samples, budget);
    return { file: b.file, samplesDir: profileFile(d.paths.cache, b.section.cftVersion).samples, tabcap: b.section, echo: { url: echo.url("/"), connections: echo.stats.connections, tlsErrors: echo.stats.tlsErrors }, profile: b.profile };
  } finally {
    await echo.stop();
  }
}
