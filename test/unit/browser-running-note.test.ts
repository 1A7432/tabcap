// `browser start` while the browser already runs (docs/04 §42: `alreadyRunning:true`
// plus a `note` when what this call asks for would only apply after `browser stop`
// and `browser start`). Besides the custom Chrome args, an explicit --proxy /
// --webdriver (or its config.json default) that differs from the running browser
// gets the same note; nothing is compared when neither the flag nor the config
// key is given. Expected values: the running browser's info and the flags below,
// with webdriver following the final command line (docs/04 §42 merge rule 3).

import { describe, expect, test } from "bun:test";
import { runningNote } from "../../src/daemon/tools/browser.ts";
import { HIDE_WEBDRIVER_FLAG } from "../../src/daemon/transport/direct/launcher.ts";

const NONE = { add: [] as string[], drop: [] as string[] };
const info = (o: Partial<{ extraArgs: string[]; dropArgs: string[]; proxy: string; webdriver: "hidden" | "visible"; args: string[] }> = {}) => ({
  extraArgs: [],
  dropArgs: [],
  proxy: "system",
  webdriver: "hidden" as const,
  args: ["--user-data-dir=/p", "--remote-debugging-pipe", HIDE_WEBDRIVER_FLAG],
  ...o,
});
const STOP_START = "run `tabcap browser stop`, then `tabcap browser start` for these to apply";

describe("browser start on a running browser: the note", () => {
  test("same everything, or nothing asked: no note", () => {
    expect(runningNote({ custom: NONE, proxy: null, webdriver: null }, info())).toBeNull();
    expect(runningNote({ custom: NONE, proxy: "system", webdriver: "hidden" }, info())).toBeNull();
    expect(runningNote({ custom: NONE, proxy: "none", webdriver: "visible" }, info({ proxy: "none", webdriver: "visible", args: ["--proxy-server=127.0.0.1:1"] }))).toBeNull();
  });

  test("custom args differ: the 0.8.1-A note, word for word", () => {
    expect(runningNote({ custom: { add: ["--headless"], drop: [] }, proxy: null, webdriver: null }, info())).toBe(`the running browser has other custom Chrome args; ${STOP_START}`);
  });

  test("--webdriver visible on a hidden browser (and the reverse): a note naming webdriver", () => {
    expect(runningNote({ custom: NONE, proxy: null, webdriver: "visible" }, info())).toBe(`the running browser has webdriver hidden (not visible); ${STOP_START}`);
    expect(runningNote({ custom: NONE, proxy: null, webdriver: "hidden" }, info({ webdriver: "visible", args: [] }))).toBe(`the running browser has webdriver visible (not hidden); ${STOP_START}`);
  });

  test("webdriver follows the custom args: --webdriver hidden with a drop of --disable-blink-features would start visible too, so no note", () => {
    const custom = { add: [], drop: ["--disable-blink-features"] };
    expect(runningNote({ custom, proxy: null, webdriver: "hidden" }, info({ dropArgs: ["--disable-blink-features"], webdriver: "visible", args: [] }))).toBeNull();
  });

  test("--proxy differs: a note naming the running proxy; a proxy switch among the custom args under --proxy system reads chrome-arg", () => {
    expect(runningNote({ custom: NONE, proxy: "none", webdriver: null }, info())).toBe(`the running browser has another proxy (system); ${STOP_START}`);
    const viaArg = { add: ["--proxy-server=127.0.0.1:8080"], drop: [] };
    expect(runningNote({ custom: viaArg, proxy: "system", webdriver: null }, info({ extraArgs: viaArg.add, proxy: "chrome-arg" }))).toBeNull();
  });

  test("several differ: one note listing them", () => {
    expect(runningNote({ custom: { add: ["--headless"], drop: [] }, proxy: "none", webdriver: "visible" }, info())).toBe(`the running browser has other custom Chrome args, another proxy (system), webdriver hidden (not visible); ${STOP_START}`);
  });

  test("a value a fresh start would refuse is not compared here (no new error on a running browser)", () => {
    expect(runningNote({ custom: NONE, proxy: "bogus value", webdriver: "sideways" }, info())).toBeNull();
  });
});
