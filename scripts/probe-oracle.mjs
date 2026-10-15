#!/usr/bin/env node
// docs/05 s46: generate the Playwright oracle exports for the input probe page
// (fixtures/probe/input-probe.html). Not part of any test run and Playwright is
// not a dependency of this repository: point --playwright at an existing local
// install. Only the probe page is ever opened, served here on 127.0.0.1.
//
//   node scripts/probe-oracle.mjs --playwright <dir containing node_modules/playwright> \
//        --chrome <Chrome for Testing binary> [--out fixtures/probe/oracle]
//
// Modes (each in a fresh headless browser and a fresh page load):
//   click     page.click("#target")
//   js_click  page.evaluate(() => document.getElementById("target").click())
//   type      page.type("#field", "aB3 中")
//   fill      page.locator("#field").fill("aB3 中")
// Output: <out>/playwright-<pw version>-cft-<chrome version>-<mode>.json, the
// page's own report (run, target box, field value, summary, events) plus meta.
// Check the files by hand before committing them (docs/05 s46).

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(join(ROOT, "fixtures", "probe", "input-probe.html"));
export const TYPE_TEXT = "aB3 中";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const pwDir = arg("--playwright");
const chrome = arg("--chrome");
const out = resolve(arg("--out") ?? join(ROOT, "fixtures", "probe", "oracle"));
if (!pwDir || !chrome) {
  console.error("usage: node scripts/probe-oracle.mjs --playwright <dir> --chrome <binary> [--out dir]");
  process.exit(2);
}
const require = createRequire(join(resolve(pwDir), "index.js"));
const { chromium } = require("playwright");
const pwVersion = JSON.parse(readFileSync(require.resolve("playwright/package.json"), "utf8")).version;
const chromeVersion = (execFileSync(chrome, ["--version"], { encoding: "utf8" }).match(/(\d+\.\d+\.\d+\.\d+)/) ?? ["", "unknown"])[1];

const reports = new Map();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/report" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const r = JSON.parse(body);
        reports.set(String(r.run), r);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  if (url.pathname === "/probe") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

async function waitReport(run) {
  for (let i = 0; i < 100 && !reports.has(run); i++) await new Promise((r) => setTimeout(r, 100));
  const r = reports.get(run);
  if (!r) throw new Error(`no report for ${run}`);
  return r;
}

mkdirSync(out, { recursive: true });
for (const mode of ["click", "js_click", "type", "fill"]) {
  const profile = mkdtempSync(join(tmpdir(), "probe-oracle-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const run = `playwright-${mode}`;
    await page.goto(`${origin}/probe?run=${run}`, { waitUntil: "load" });
    if (mode === "click") await page.click("#target");
    else if (mode === "js_click") await page.evaluate(() => document.getElementById("target").click());
    else if (mode === "type") await page.type("#field", TYPE_TEXT);
    else await page.locator("#field").fill(TYPE_TEXT);
    if (mode === "type" || mode === "fill") {
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__probeReport());
    }
    const r = await waitReport(run);
    const file = join(out, `playwright-${pwVersion}-cft-${chromeVersion}-${mode}.json`);
    const { href: _href, at: _at, ...report } = r;
    const doc = {
      meta: { tool: "Playwright", toolVersion: pwVersion, browser: `Chrome for Testing ${chromeVersion}`, headless: true, mode, text: mode === "type" || mode === "fill" ? TYPE_TEXT : null, page: "fixtures/probe/input-probe.html" },
      report,
    };
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    console.log(`[${mode}] ${file} events=${report.events.length}`);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
server.close();
