import { describe, expect, test } from "bun:test";
import { blobHex, blobRef, cmdId, navId, requestId, seqOf, sha256Hex, tabId, ulid } from "../../src/shared/ids.ts";
import { monotonicToMono, tsToIso, wallTimeToTs } from "../../src/shared/time.ts";
import { TabcapError, fail, ok, toFail } from "../../src/shared/envelope.ts";

describe("ids", () => {
  test("seq-derived ids (docs/04 §6)", () => {
    expect([tabId(1), navId(3), requestId(57), cmdId(9)]).toEqual(["t1", "n-3", "r-57", "c-9"]);
    expect(seqOf("r-57", "r")).toBe(57);
    expect(seqOf("n-3", "r")).toBeNull();
    expect(seqOf("r-0", "r")).toBeNull();
  });

  test("blob refs are sha256:<64 lowercase hex>", () => {
    // Oracle: Bun's own hasher, independent of node:crypto used by ids.ts.
    const h = new Bun.CryptoHasher("sha256").update("abc").digest("hex");
    expect(sha256Hex("abc")).toBe(h);
    expect(blobRef(h.toUpperCase())).toBe(`sha256:${h}`);
    expect(blobHex(`sha256:${h}`)).toBe(h);
    expect(blobHex("sha256:XYZ")).toBeNull();
    expect(() => blobRef("abc")).toThrow();
  });

  test("ULID time prefix matches the ulid reference README example", () => {
    // github.com/ulid/javascript README: ulid(1469918176385) -> 01ARYZ6S41...
    expect(ulid(1469918176385, new Uint8Array(10)).slice(0, 10)).toBe("01ARYZ6S41");
    expect(ulid(0, new Uint8Array(10))).toBe("0".repeat(26));
    expect(ulid(0, new Uint8Array(10).fill(255)).slice(10)).toBe("Z".repeat(16));
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("time", () => {
  test("CDP seconds -> ms", () => {
    expect(wallTimeToTs(1760500000.1234)).toBe(1760500000123.4);
    expect(monotonicToMono(88.12345)).toBe(88123.45);
    expect(tsToIso(1760500000000)).toBe("2025-10-15T03:46:40.000Z");
  });
});

describe("envelope", () => {
  test("ok / fail / toFail keep next", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    expect(fail("usage", "m", "n")).toEqual({ ok: false, error: { code: "usage", message: "m", next: "n" } });
    expect(toFail(new TabcapError("not-found", "x", "do y")).error).toEqual({ code: "not-found", message: "x", next: "do y" });
    expect(toFail(new Error("boom")).error.code).toBe("internal");
  });
});
