// Decoding for key rules (0.6-C, docs/04 §31): body "decoded" keys and
// compare "status+decoded-body" read plaintext through a decode plugin
// (0.6-B, daemon/hooks/decode.ts). A plugin a rule names (`decodeWith`) must
// be installed with a valid manifest; naming it in the rules is the opt-in,
// so it need not be enabled (like `bundle decode --plugin`). A plugin taken
// from a recorded view (`decoded.by`) is used the same way. The plugin's
// match (host, path, content type) still decides whether it takes a body.

import { asDecodePlugin, listPlugins } from "../daemon/hooks/plugins.ts";
import { DecodeHost, DecodeSession, type DecodeDirection, type DecodePlugin } from "../daemon/hooks/decode.ts";
import type { Headers } from "../bundle/types.ts";
import type { Plain } from "./match.ts";

export type PlainJob = {
  direction: DecodeDirection;
  id: string | null;
  url: string;
  method: string;
  requestHeaders: Headers;
  response: { status: number | null; headers: Headers } | null;
  body: Uint8Array;
  mime: string | null;
};

/** One decode plugin process per named plugin for one command run. */
export class Plaintexts {
  private readonly host = new DecodeHost();
  private readonly sessions = new Map<string, DecodeSession | string>();
  private installed: DecodePlugin[] | null = null;

  constructor(private readonly configDir: string) {}

  private plugin(name: string): DecodePlugin | string {
    this.installed ??= listPlugins(this.configDir).flatMap(asDecodePlugin);
    return this.installed.find((p) => p.name === name) ?? `decode plugin ${name} is not installed (or its manifest is invalid; see tabcap plugin list)`;
  }

  /** Is the plugin usable here? null when it is, else why not. */
  problem(name: string): string | null {
    const p = this.plugin(name);
    return typeof p === "string" ? p : null;
  }

  /** The plaintext of one body by one plugin; never throws. */
  async decode(name: string, job: PlainJob): Promise<Plain> {
    let s = this.sessions.get(name);
    if (s === undefined) {
      const p = this.plugin(name);
      s = typeof p === "string" ? p : new DecodeSession(this.host, [p]);
      this.sessions.set(name, s);
    }
    if (typeof s === "string") return { error: s };
    if (s.isDisabled(name)) return { error: `decode plugin ${name} was disabled after repeated failures` };
    const out = await s.decode(job);
    if (out === null) return { error: `decode plugin ${name} does not take this body (match)` };
    if (!out.ok) return { error: `decode plugin ${name} could not decode it (${out.error})` };
    return { bytes: out.body, mime: out.mime };
  }

  close(): void {
    this.host.close();
  }
}
