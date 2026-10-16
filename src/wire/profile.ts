// The browser baseline (`tabcap wire profile`): which file a profile lives in,
// what makes a cached one reusable (Chrome for Testing version + sha256 of the
// exact launch flags: --disable-field-trial-config alone changes the
// ClientHello, docs/07 §6), and the `tabcap` section tabcap adds to the
// component's profile JSON. Pure helpers; the capture itself is
// src/daemon/tools/wire.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../shared/json.ts";

export const PROFILE_DIR = ["wire", "profiles"] as const;

/** Launch flags with machine-specific paths replaced, in launch order (what the hash covers). */
export function normalizedFlags(args: readonly string[]): string[] {
  return args.map((a) => {
    if (a.startsWith("--user-data-dir=")) return "--user-data-dir=<profile>";
    if (a.startsWith("--load-extension=")) return "--load-extension=<extension>";
    return a;
  });
}

export function flagsSha256(flags: readonly string[]): string {
  return new Bun.CryptoHasher("sha256").update(flags.join("\n")).digest("hex");
}

/** "Chrome/155.0.8059.79" (Browser.getVersion product) → "155.0.8059.79". */
export function cftVersion(product: string): string | null {
  return /(\d+\.\d+\.\d+\.\d+)/.exec(product)?.[1] ?? null;
}

export function profileOs(platform: NodeJS.Platform = process.platform): "macos" | "linux" | "windows" | "other" {
  return platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : "other";
}

export function profileArch(arch: string = process.arch): string {
  return arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
}

/** <cache>/wire/profiles/cft-<version>-<os>-<arch>.json and its samples directory. */
export function profileFile(cacheDir: string, version: string, os: string = profileOs(), arch: string = profileArch()): { file: string; samples: string; name: string } {
  const name = `cft-${version}-${os}-${arch}`;
  const dir = join(cacheDir, ...PROFILE_DIR);
  return { file: join(dir, `${name}.json`), samples: join(dir, `${name}.samples`), name };
}

export type TabcapSection = {
  cftVersion: string;
  flagsSha256: string;
  flags: string[];
  tabcapVersion: string;
  capturedAt: string;
  samples: { navigation: number; fetch: number };
  psk: { navigation: number; fetch: number };
  sessionTickets: "disabled";
};

/** The cached profile's `tabcap` section when it matches this browser (version and flags hash), else null. */
export function reusable(file: string, version: string, hash: string): TabcapSection | null {
  if (!existsSync(file)) return null;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(v) || !isRecord(v["tabcap"])) return null;
  const t = v["tabcap"];
  if (t["cftVersion"] !== version || t["flagsSha256"] !== hash) return null;
  const s = t["samples"];
  const p = t["psk"];
  if (!isRecord(s) || !isRecord(p) || !Array.isArray(t["flags"])) return null;
  return {
    cftVersion: version,
    flagsSha256: hash,
    flags: t["flags"].filter((x): x is string => typeof x === "string"),
    tabcapVersion: typeof t["tabcapVersion"] === "string" ? t["tabcapVersion"] : "",
    capturedAt: typeof t["capturedAt"] === "string" ? t["capturedAt"] : "",
    samples: { navigation: Number(s["navigation"] ?? 0), fetch: Number(s["fetch"] ?? 0) },
    psk: { navigation: Number(p["navigation"] ?? 0), fetch: Number(p["fetch"] ?? 0) },
    sessionTickets: "disabled",
  };
}

/** Arguments of the component's `profile` for a tabcap CfT capture. */
export function profileArgs(o: { version: string; os: string; arch: string; capturedAt: string; tabcapVersion: string; reports: string[] }): string[] {
  return [
    "profile",
    "--kind",
    "browser",
    "--name",
    "chrome",
    "--channel",
    "for-testing",
    "--version",
    o.version,
    "--os",
    o.os,
    "--arch",
    o.arch,
    "--method",
    "tabcap-wire-profile",
    "--captured-at",
    o.capturedAt,
    "--server",
    `tabcap-wire-echo ${o.tabcapVersion}`,
    "--server-host-os",
    o.os,
    "--notes",
    "Chrome for Testing launched by tabcap with its own flags (tabcap section); navigation and page fetch samples from the local wire echo",
    ...o.reports,
  ];
}
