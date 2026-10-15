// ~/.config/tabcap/config.json: written by `tabcap setup`, read by the launcher.
// The file is user-editable, so it is parsed as untrusted JSON.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../bundle/manifest.ts";
import { isRecord, str, tryParseJson } from "./json.ts";

export type TabcapConfig = {
  chrome: { executablePath: string; version: string | null; platform: string | null } | null;
  /** Default for `browser start --proxy`: "system" | "none" | <url>. */
  proxy: string | null;
};

export function readConfig(file: string): TabcapConfig {
  const empty: TabcapConfig = { chrome: null, proxy: null };
  if (!existsSync(file)) return empty;
  const raw = tryParseJson(readFileSync(file, "utf8"));
  if (!isRecord(raw)) return empty;
  const c = raw["chrome"];
  const chrome =
    isRecord(c) && str(c, "executablePath") !== null
      ? { executablePath: str(c, "executablePath") ?? "", version: str(c, "version"), platform: str(c, "platform") }
      : null;
  return { chrome, proxy: str(raw, "proxy") };
}

export function writeConfig(file: string, cfg: TabcapConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n");
}
