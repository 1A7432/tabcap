// 0.6-U: `trace start --decode` names the enabled decode plugins (docs/04 §33
// D4: their views outrank by:"page" views). Oracle: the owner's 0.6-U brief
// (a `decodePlugins` field with the enabled decode plugin names, a sentence
// naming `tabcap plugin disable <name>`; nothing when none is enabled) and the
// plugin registry on disk (src/daemon/hooks/plugins.ts, `plugin enable`).

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnabled } from "../../src/daemon/hooks/plugins.ts";
import { parseTraceConfig } from "../../src/shared/config.ts";
import { decodeNotice, decodePluginsFields, withDecodePlugins } from "../../src/daemon/tools/trace.ts";
import { installXor, XOR_PLUGIN } from "./_decode.ts";

const root = mkdtempSync(join(tmpdir(), "tabcap-trace06u-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("trace start --decode: enabled decode plugins (0.6-U)", () => {
  test("none installed, or installed but not enabled: no fields", () => {
    expect(decodePluginsFields(join(root, "empty"))).toEqual({});
    const off = join(root, "off");
    installXor(off, false);
    expect(decodePluginsFields(off)).toEqual({});
  });

  test("one enabled: its name, and the notice names `tabcap plugin disable <it>`", () => {
    const on = join(root, "on");
    installXor(on);
    const f = decodePluginsFields(on);
    expect(f.decodePlugins).toEqual(["xor-decode"]);
    expect(f.decodePluginsNotice).toContain("outrank");
    expect(f.decodePluginsNotice).toContain("`tabcap plugin disable xor-decode`");
  });

  test("two enabled: both names in name order; disabling one leaves the other", () => {
    const two = join(root, "two");
    installXor(two);
    const dir = join(two, "plugins", "a-decode");
    cpSync(XOR_PLUGIN, dir, { recursive: true });
    // the copied manifest names xor-decode; the second plugin needs its own name (= its directory)
    const mf = join(dir, "manifest.json");
    const m: unknown = JSON.parse(readFileSync(mf, "utf8"));
    writeFileSync(mf, JSON.stringify({ ...(typeof m === "object" && m !== null ? m : {}), name: "a-decode" }));
    setEnabled(two, "a-decode", true);
    const f = decodePluginsFields(two);
    expect(f.decodePlugins).toEqual(["a-decode", "xor-decode"]);
    expect(f.decodePluginsNotice).toContain("`tabcap plugin disable <name>`");
    setEnabled(two, "a-decode", false);
    expect(decodePluginsFields(two).decodePlugins).toEqual(["xor-decode"]);
  });
});

// 0.6-V (owner decision 10-17): `trace status` and `trace stop` carry the same
// two fields while decode is on; a signal-tracing answer (no `decode` block)
// is unchanged. And the `--decode` notice says what happens to weak rows.
describe("trace status / stop: the decode-plugin notice while decode is on (0.6-V)", () => {
  test("with a decode block: the fields are added; without one, or with no plugin enabled: unchanged", () => {
    const on = join(root, "status-on");
    installXor(on);
    const status = { session: "s", trace: "on", decode: { armed: 0 }, weakRows: true };
    const f = withDecodePlugins(status, on);
    expect(f["decodePlugins"]).toEqual(["xor-decode"]);
    expect(String(f["decodePluginsNotice"])).toContain("`tabcap plugin disable xor-decode`");
    expect(f).toMatchObject(status);
    const signals = { session: "s", trace: "on", hits: 3 };
    expect(withDecodePlugins(signals, on)).toEqual(signals);
    expect(withDecodePlugins(status, join(root, "status-none"))).toEqual(status);
  });

  test("config.json trace.weakRows: default true, a boolean or an error", () => {
    expect(parseTraceConfig(undefined)).toEqual({ decode: false, weakRows: true });
    expect(parseTraceConfig({})).toEqual({ decode: false, weakRows: true });
    expect(parseTraceConfig({ weakRows: false })).toEqual({ decode: false, weakRows: false });
    expect(parseTraceConfig({ decode: true, weakRows: false })).toEqual({ decode: true, weakRows: false });
    expect(() => parseTraceConfig({ weakRows: "yes" })).toThrow("trace.weakRows is invalid");
  });

  test("the --decode notice: weak rows named as such by default; counted, not filed, when trace.weakRows is false", () => {
    expect(decodeNotice(true)).toContain('evidence.link "weak" means it was only the one armed suspect');
    expect(decodeNotice(true)).toContain("trace.weakRows: false");
    expect(decodeNotice(false)).toContain("counted as drops.weak, not filed");
    expect(decodeNotice(false)).not.toContain('"weak" means');
  });
});
