import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/bundle/blobs.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "tabcap-blobs-"));

describe("BlobStore", () => {
  test("content addressed, deduplicated, layout blobs/sha256/<xx>/<hash>", async () => {
    const dir = tmp();
    const store = new BlobStore(dir);
    const bytes = new TextEncoder().encode("hello evidence");
    const hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

    const first = await store.put(bytes);
    expect(first).toEqual({ outcome: "stored", ref: `sha256:${hex}`, size: bytes.length, existed: false });
    const second = await store.put("hello evidence");
    expect(second).toEqual({ outcome: "stored", ref: `sha256:${hex}`, size: bytes.length, existed: true });

    const sub = join(dir, "blobs", "sha256", hex.slice(0, 2));
    expect(readdirSync(sub)).toEqual([hex]); // no temp files left behind
    expect(store.read(`sha256:${hex}`)).toEqual(bytes);
  });

  test("too-large is reported, nothing written", async () => {
    const dir = tmp();
    const store = new BlobStore(dir, { sizeCap: 10 });
    const r = await store.put(new Uint8Array(11));
    expect(r).toEqual({ outcome: "too-large", size: 11, cap: 10 });
    expect(existsSync(join(dir, "blobs"))).toBe(false);
    expect((await store.put(new Uint8Array(10))).outcome).toBe("stored");
  });

  test("default cap is 32 MiB (decision c)", () => {
    expect(new BlobStore(tmp()).sizeCap).toBe(32 * 1024 * 1024);
  });

  test("reads reject malformed refs and report missing blobs", () => {
    const store = new BlobStore(tmp());
    expect(() => store.read("sha256:../../etc/passwd")).toThrow(/malformed/);
    expect(() => store.read(`sha256:${"0".repeat(64)}`)).toThrow(/not in/);
    expect(store.tryRead(`sha256:${"0".repeat(64)}`)).toBeNull();
  });
});
