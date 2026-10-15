import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { exportHar } from "../../src/bundle/har.ts";
import { BundleReader } from "../../src/bundle/reader.ts";
import { redactBundle } from "../../src/bundle/redact.ts";
import { JWT, SECRET_SID, buildRichBundle } from "./_fixtures.ts";

const tmp = (p = "tabcap-redact-") => mkdtempSync(join(tmpdir(), p));

/** Placeholder computed independently from the spec formula (§8). */
const placeholder = (kind: string, salt: string, value: string) =>
  `«r:${kind}:${new Bun.CryptoHasher("sha256").update(salt + value).digest("hex").slice(0, 8)}»`;

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function redactedRich() {
  const src = tmp("tabcap-rich-");
  await buildRichBundle(src);
  const before = snapshotTree(src);
  const out = join(tmp(), "copy");
  const res = await redactBundle(src, out, { now: () => 1760500999000 });
  const salt = readFileSync(join(src, "exports", "copy.salt"), "utf8").trim();
  return { src, out, res, salt, before, copy: BundleReader.open(out), orig: BundleReader.open(src) };
}

describe("redaction (docs/04 §8)", () => {
  test("same secret -> same placeholder across cookie header, query and JSON body", async () => {
    const { copy, salt } = await redactedRich();
    const ph = placeholder("secret", salt, SECRET_SID);
    const r4 = copy.requests().find((q) => q.id === "r-4");
    if (r4 === undefined) throw new Error("r-4 missing");
    expect(r4.request.headers["cookie"]).toBe(`sid=${ph}; theme=${placeholder("secret", salt, "dark")}`);
    expect(r4.url).toContain(`sid=${ph}`);
    const body = new TextDecoder().decode(copy.readBlob(r4.response?.body?.blob ?? "") ?? new Uint8Array());
    expect(JSON.parse(body).items[0].sid).toBe(ph);
    expect(body).not.toContain(SECRET_SID);
    // set-cookie keeps attributes, masks the value
    expect(r4.response?.headers["set-cookie"]).toEqual([`sid=${ph}; Path=/; HttpOnly`, `theme=${placeholder("secret", salt, "dark")}`]);
  });

  test("authorization is masked (JWT kind); non-sensitive fields untouched", async () => {
    const { copy, salt } = await redactedRich();
    const r4 = copy.requests().find((q) => q.id === "r-4");
    expect(r4?.request.headers["authorization"]).toBe(`Bearer ${placeholder("jwt", salt, JWT)}`);
    expect(r4?.request.headers["accept"]).toBe("application/json");
    expect(r4?.url.startsWith("http://127.0.0.1:4310/api/items?page=2&")).toBe(true);
    expect(r4?.url).toContain(`q=${placeholder("mobile", salt, "13800138000")}`);
    const body = JSON.parse(new TextDecoder().decode(copy.readBlob(r4?.response?.body?.blob ?? "") ?? new Uint8Array()));
    expect(body.items[0].title).toBe("条目 A");
    expect(body.contact).toBe(placeholder("email", salt, "demo@example.com"));
    // form body: password masked by name, other params untouched
    const r5 = copy.requests().find((q) => q.id === "r-5");
    const pd = r5?.request.postData;
    expect(pd !== null && pd !== undefined && "inline" in pd ? pd.inline : null).toBe(
      `user=demo&password=${placeholder("secret", salt, "hunter2secret")}&remember=1`,
    );
    expect(r5?.request.headers["x-api-key"]).toBe(placeholder("secret", salt, "k-998877"));
  });

  test("state blob values masked; same placeholder as the cookie header", async () => {
    const { copy, salt } = await redactedRich();
    const st = copy.byKind("state")[0];
    const cookies = JSON.parse(new TextDecoder().decode(copy.readBlob(String(st?.["blob"])) ?? new Uint8Array()));
    expect(cookies.map((c: { value: string }) => c.value)).toEqual([placeholder("secret", salt, SECRET_SID), placeholder("secret", salt, "dark")]);
    expect(cookies[0].name).toBe("sid");
  });

  test("copy has manifest.redaction and recomputed counts; source unchanged; salt only in source exports/", async () => {
    const { src, out, res, salt, before, copy, orig } = await redactedRich();
    expect(copy.manifest.redaction).toEqual({ rules: "default@1", applied: 1760500999000 });
    expect(orig.manifest.redaction).toBeNull();
    expect(copy.manifest.counts.events).toBe(orig.events.length);
    expect(copy.manifest.counts.requests).toBe(orig.manifest.counts.requests);
    const onDisk = Object.entries(snapshotTree(out))
      .filter(([p]) => p.startsWith("blobs/"))
      .reduce((n, [p]) => n + statSync(join(out, p)).size, 0);
    expect(copy.manifest.counts.blobBytes).toBe(onDisk);
    expect(copy.events.map((e) => e.seq)).toEqual(orig.events.map((e) => e.seq));
    expect(res.blobsRewritten).toBeGreaterThan(0);
    expect(res.missingBlobs).toEqual([]);

    const after = snapshotTree(src);
    const withoutExports = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([p]) => !p.startsWith("exports/")));
    expect(withoutExports(after)).toEqual(before);
    expect(Object.keys(after).filter((p) => p.startsWith("exports/"))).toEqual(["exports/copy.salt"]);

    for (const p of Object.keys(snapshotTree(out))) {
      expect(readFileSync(join(out, p)).includes(salt)).toBe(false);
      expect(readFileSync(join(out, p)).includes(SECRET_SID)).toBe(false);
    }
  });

  test("HAR export with redaction leaks neither the secret nor the password", async () => {
    const src = tmp("tabcap-rich-");
    await buildRichBundle(src);
    const har = JSON.stringify(exportHar(BundleReader.open(src), { redact: { salt: "s" }, embedEvents: true }).har);
    for (const secret of [SECRET_SID, "hunter2secret", JWT, "13800138000", "demo@example.com"]) expect(har.includes(secret)).toBe(false);
    expect(har).toContain(placeholder("secret", "s", SECRET_SID));
  });

  test("refuses a non-empty output directory", async () => {
    const src = tmp("tabcap-rich-");
    await buildRichBundle(src);
    await expect(redactBundle(src, src)).rejects.toMatchObject({ code: "conflict" });
  });
});
