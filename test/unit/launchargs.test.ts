// Review 10-21: the launch arguments written into a bundle manifest and hashed
// for the wire baseline cache (docs/04 §42, docs/07 §6). Expected values follow
// the rules the owner approved on 10-21: a URL value loses its user:pass@, a
// home-directory prefix becomes <home> (the rest of the path stays), tabcap's
// profile and extension stay <profile> / <extension>, and --load-extension is
// normalized item by item. The default command line must hash as in 0.8.1, so
// cached wire profiles stay valid.

import { describe, expect, test } from "bun:test";
import { buildArgs, parseProxy } from "../../src/daemon/transport/direct/launcher.ts";
import { normalizedLaunchArgs } from "../../src/shared/launchargs.ts";
import { flagsSha256 } from "../../src/wire/profile.ts";

const HOME = "/Users/alice";
const ctx = { home: HOME, extensionDir: `${HOME}/tabcap/extension` };

describe("normalizedLaunchArgs (docs/04 §42)", () => {
  test("a URL value loses its user:pass@ (also inside a list), nothing else of it", () => {
    expect(normalizedLaunchArgs(["--proxy-server=http://alice:hunter2@127.0.0.1:8080"], ctx)).toEqual(["--proxy-server=http://127.0.0.1:8080"]);
    expect(normalizedLaunchArgs(["--proxy-server=socks5://u@h:1080"], ctx)).toEqual(["--proxy-server=socks5://h:1080"]);
    expect(normalizedLaunchArgs(["--proxy-pac-url=https://u:p@w@pac.example/p.pac?x=1"], ctx)).toEqual(["--proxy-pac-url=https://pac.example/p.pac?x=1"]);
    expect(normalizedLaunchArgs(["--x=http://a:b@h1:1,https://c@h2/p"], ctx)).toEqual(["--x=http://h1:1,https://h2/p"]);
    expect(normalizedLaunchArgs(["--x=http://h/p@q", "--user-agent=Me@Home/1.0"], ctx)).toEqual(["--x=http://h/p@q", "--user-agent=Me@Home/1.0"]);
  });

  test("a home-directory prefix becomes <home>, the rest of the path stays; a longer sibling name is not home", () => {
    expect(normalizedLaunchArgs(["--disk-cache-dir=/Users/alice/cache", "--disable-extensions-except=/Users/alice/ext", "--x=/Users/alice"], ctx)).toEqual([
      "--disk-cache-dir=<home>/cache",
      "--disable-extensions-except=<home>/ext",
      "--x=<home>",
    ]);
    // a path starts at the value, after a list separator or `=`, or after file://
    expect(normalizedLaunchArgs(["--x=a,/Users/alice/b;/Users/alice/c", "--js-flags=--log=/Users/alice/v8.log", "--y=file:///Users/alice/p.pac"], ctx)).toEqual([
      "--x=a,<home>/b;<home>/c",
      "--js-flags=--log=<home>/v8.log",
      "--y=file://<home>/p.pac",
    ]);
    // not home: a longer sibling name, the same text inside another path
    expect(normalizedLaunchArgs(["--disk-cache-dir=/Users/alice2/cache", "--x=/opt/Users/alice/y"], ctx)).toEqual(["--disk-cache-dir=/Users/alice2/cache", "--x=/opt/Users/alice/y"]);
    expect(normalizedLaunchArgs(["--disk-cache-dir=C:\\Users\\alice\\cache"], { home: "C:\\Users\\alice", extensionDir: null })).toEqual(["--disk-cache-dir=<home>\\cache"]);
    // no usable home: nothing replaced
    for (const home of [null, "", "/"]) expect(normalizedLaunchArgs(["--disk-cache-dir=/Users/alice/cache"], { home, extensionDir: null })).toEqual(["--disk-cache-dir=/Users/alice/cache"]);
  });

  test("<profile> and <extension> stay; --load-extension item by item: tabcap's <extension>, the user's normalized", () => {
    const args = [`--user-data-dir=${HOME}/Library/Application Support/tabcap/profiles/default`, `--load-extension=${ctx.extensionDir},${HOME}/my-ext,/opt/ext`];
    expect(normalizedLaunchArgs(args, ctx)).toEqual(["--user-data-dir=<profile>", "--load-extension=<extension>,<home>/my-ext,/opt/ext"]);
    expect(normalizedLaunchArgs([`--load-extension=${HOME}/my-ext`], ctx)).toEqual(["--load-extension=<home>/my-ext"]);
    expect(normalizedLaunchArgs([`--load-extension=${HOME}/my-ext`], { home: HOME, extensionDir: null })).toEqual(["--load-extension=<home>/my-ext"]);
  });

  test("switches without a value and positionals are kept as launched; pure", () => {
    const args = ["--remote-debugging-pipe", "about:blank", "--disable-sync"];
    const copy = [...args];
    expect(normalizedLaunchArgs(args, ctx)).toEqual(args);
    expect(args).toEqual(copy);
  });
});

describe("the wire baseline cache key (docs/07 §6)", () => {
  /** What 0.8.1 hashed: only the profile and the whole extension list replaced. */
  const as081 = (args: string[]): string[] =>
    args.map((a) => (a.startsWith("--user-data-dir=") ? "--user-data-dir=<profile>" : a.startsWith("--load-extension=") ? "--load-extension=<extension>" : a));

  test("tabcap's own command line normalizes and hashes as in 0.8.1 (no cached profile goes stale)", () => {
    for (const proxy of ["system", "none", "http://127.0.0.1:8080"]) {
      for (const extensionDir of [null, ctx.extensionDir]) {
        for (const cdp of ["pipe", "port"] as const) {
          const args = buildArgs({ profileDir: `${HOME}/Library/Application Support/tabcap/profiles/default`, platform: "darwin", cdp, proxy: parseProxy(proxy), webdriver: "hidden", extensionDir, noStartupWindow: true });
          const n = normalizedLaunchArgs(args, { home: HOME, extensionDir });
          expect(n).toEqual(as081(args));
          expect(flagsSha256(n)).toBe(flagsSha256(as081(args)));
        }
      }
    }
  });
});
