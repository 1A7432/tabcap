// docs/04 §54 (the gaps a day of real use on Windows found, 2026-11-13):
// §54.1 `evaluate --file`, §54.2 `screenshot --scale`, §54.3 `--ascii`, and
// the §54.4 hint texts. Pure functions only; the browser side is
// test/e2e/v12a.e2e.test.ts (docs/05 s80).

import { describe, expect, test } from "bun:test";
import { EVAL_FILE_MAX_BYTES, asBlock, decodeScript, evaluateArgs } from "../../src/cli/evalfile.ts";
import { asciiJson, asciiOutput, envelopeLine, run, takeOutputFlags } from "../../src/cli/main.ts";
import { TAKEOVER_NEXT, TAKEOVER_SCRIPT_NOTE } from "../../src/daemon/guard.ts";
import { PREVIEW_HINT, REDACTED_HINT } from "../../src/daemon/tools/net.ts";
import { SHOT_SCALE_MIN, shotScale, viewportClip } from "../../src/daemon/tools/page.ts";
import { TabcapError, ok } from "../../src/shared/envelope.ts";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof TabcapError ? e.code : `not a TabcapError: ${String(e)}`;
  }
  return "no error";
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf16le = (s: string): Uint8Array => {
  const b = new Uint8Array(2 + s.length * 2);
  b.set([0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 + i * 2] = c & 0xff;
    b[3 + i * 2] = c >> 8;
  }
  return b;
};
const utf16be = (s: string): Uint8Array => {
  const le = utf16le(s);
  const b = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) {
    b[i] = le[i + 1] ?? 0;
    b[i + 1] = le[i] ?? 0;
  }
  return b;
};

const SCRIPT = "// 取密码框的位置\nconst el = document.querySelector('input[placeholder*=\"密码\"]');\nel.getBoundingClientRect().toJSON()";

describe("evaluate --file (docs/04 §54.1)", () => {
  test("UTF-8, with and without a byte order mark, and UTF-16 with one: the same text", () => {
    expect(decodeScript(utf8(SCRIPT), "s.js")).toBe(SCRIPT);
    expect(decodeScript(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(SCRIPT)]), "s.js")).toBe(SCRIPT);
    expect(decodeScript(utf16le(SCRIPT), "s.js")).toBe(SCRIPT);
    expect(decodeScript(utf16be(SCRIPT), "s.js")).toBe(SCRIPT);
  });

  test("bytes of another code page (GBK here) are refused, never guessed", () => {
    // "密码" in GBK: c3 dc c2 eb
    const gbk = Uint8Array.from([0x2f, 0x2f, 0x20, 0xc3, 0xdc, 0xc2, 0xeb, 0x0a, 0x31]);
    expect(codeOf(() => decodeScript(gbk, "s.js"))).toBe("bad-input");
    // an odd byte count after a UTF-16 mark
    expect(codeOf(() => decodeScript(Uint8Array.from([0xff, 0xfe, 0x31]), "s.js"))).toBe("bad-input");
  });

  test("the script is sent as one block: the brace on line 1, the closing one on its own line", () => {
    expect(asBlock("const a = 1;\na // done")).toBe("{const a = 1;\na // done\n}");
    // the block's value is its last expression statement's, and its const does not leak
    expect((0, eval)(asBlock("const gaps54 = 20;\n({ v: gaps54 + 1 })"))).toEqual({ v: 21 });
    expect((0, eval)("typeof gaps54")).toBe("undefined");
    expect((0, eval)(asBlock("const gaps54 = 20;\n({ v: gaps54 + 1 })"))).toEqual({ v: 21 });
  });

  test("--file becomes `expression`; the other arguments pass through; `file` is not sent", () => {
    const sent = evaluateArgs({ file: "/w/s.js", await: true, tab: "t2", timeoutMs: 5000 }, (p) => {
      expect(p).toBe("/w/s.js");
      return utf8(SCRIPT);
    });
    expect(sent).toEqual({ expression: asBlock(SCRIPT), await: true, tab: "t2", timeoutMs: 5000 });
  });

  test("without --file the arguments are returned as they are", () => {
    const a = { expression: "1+1" };
    expect(evaluateArgs(a, () => utf8("never read"))).toBe(a);
  });

  test("with an expression or --function: usage; empty, unreadable and oversize files are errors", () => {
    const read = () => utf8("1");
    expect(codeOf(() => evaluateArgs({ file: "s.js", expression: "2" }, read))).toBe("usage");
    expect(codeOf(() => evaluateArgs({ file: "s.js", function: "() => 1" }, read))).toBe("usage");
    expect(codeOf(() => evaluateArgs({ file: "s.js" }, () => utf8(" \n\t")))).toBe("bad-input");
    expect(codeOf(() => evaluateArgs({ file: "s.js" }, () => new Uint8Array(EVAL_FILE_MAX_BYTES + 1)))).toBe("bad-input");
    expect(codeOf(() => evaluateArgs({ file: "/no/such/dir/tabcap-s.js" }))).toBe("not-found");
  });
});

describe("screenshot --scale (docs/04 §54.2)", () => {
  test("0.1 to 1; 1 and absent mean no scaling", () => {
    expect(shotScale({})).toBeNull();
    expect(shotScale({ scale: 1 })).toBeNull();
    expect(shotScale({ scale: 0.5 })).toBe(0.5);
    expect(shotScale({ scale: SHOT_SCALE_MIN })).toBe(SHOT_SCALE_MIN);
    for (const bad of [0, 0.05, 1.5, -1, Number.NaN]) expect(codeOf(() => shotScale({ scale: bad }))).toBe("usage");
  });

  test("the viewport clip is the visual viewport in page coordinates", () => {
    const m = { cssVisualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 1500, clientWidth: 1280, clientHeight: 720, scale: 1, zoom: 1 } };
    expect(viewportClip(m, 0.5)).toEqual({ x: 0, y: 1500, width: 1280, height: 720, scale: 0.5 });
  });

  test("metrics Chrome did not fill in give null, not a guess", () => {
    expect(viewportClip({}, 0.5)).toBeNull();
    expect(viewportClip({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 0, clientHeight: 720 } }, 0.5)).toBeNull();
    expect(viewportClip({ cssVisualViewport: { pageX: "0", pageY: 0, clientWidth: 10, clientHeight: 10 } }, 0.5)).toBeNull();
  });
});

describe("--ascii (docs/04 §54.3)", () => {
  const env = ok({ title: "登录 · 银行", emoji: "🙂", latin: "ü", plain: "a\"b\\c\n" });

  test("only ASCII comes out, and it parses back to the same value", () => {
    const line = envelopeLine(env, true);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect(JSON.parse(line)).toEqual(env);
    expect(line).toContain("\\u767b\\u5f55");
    // one escape per UTF-16 code unit: a surrogate pair is two
    expect(line).toContain("\\ud83d\\ude42");
  });

  test("without it the line is JSON.stringify's", () => {
    expect(envelopeLine(env, false)).toBe(JSON.stringify(env));
  });

  test("JSON lines keep their line breaks", () => {
    expect(asciiJson('{"a":"一"}\n{"a":"二"}')).toBe('{"a":"\\u4e00"}\n{"a":"\\u4e8c"}');
  });

  test("the flag is taken out of argv like the other output flags; TABCAP_OUTPUT_ASCII=1 is the same", () => {
    const t = takeOutputFlags(["net", "list", "--ascii", "--filter", "x"]);
    expect(t.rest).toEqual(["net", "list", "--filter", "x"]);
    expect(t.out.ascii).toBe(true);
    expect(t.out.full).toBe(false);
    expect(takeOutputFlags(["net", "list", "--full"]).out.ascii).toBe(false);
    expect(asciiOutput(false, {})).toBe(false);
    expect(asciiOutput(false, { TABCAP_OUTPUT_ASCII: "1" })).toBe(true);
    expect(asciiOutput(false, { TABCAP_OUTPUT_ASCII: "0" })).toBe(false);
    expect(asciiOutput(true, {})).toBe(true);
  });

  test("run() marks the outcome, also for an error envelope", async () => {
    expect((await run(["--version", "--ascii"])).ascii).toBe(true);
    expect((await run(["--version"])).ascii).toBeUndefined();
    const bad = await run(["no-such-command", "--ascii"]);
    expect(bad.envelope.ok).toBe(false);
    expect(bad.ascii).toBe(true);
  });
});

describe("hint texts (docs/04 §54.4)", () => {
  test("take-over: says OS-level input scripts count as the user and where the switch is, before the MCP names", () => {
    const n = TAKEOVER_NEXT("default");
    expect(n).toContain(TAKEOVER_SCRIPT_NOTE);
    expect(TAKEOVER_SCRIPT_NOTE).toContain('"handoff": {"detectTakeover": false}');
    expect(TAKEOVER_SCRIPT_NOTE).toContain("tell the user");
    expect(n.indexOf(TAKEOVER_SCRIPT_NOTE)).toBeLessThan(n.indexOf("(over MCP:"));
  });

  test("a cut preview names --out / --file and says --full is not it; redaction names --reveal as the human's call", () => {
    for (const w of ["`path`", "--out", "--file", "--grep", "--lines", "--full does not"]) expect(PREVIEW_HINT).toContain(w);
    expect(REDACTED_HINT).toContain("`--reveal`");
    expect(REDACTED_HINT).toContain("only when the human asks");
  });
});
