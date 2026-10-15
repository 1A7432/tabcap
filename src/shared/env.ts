// Environment variables are named TABCAP_<NAME>. The pre-rename BBL_<NAME>
// fallback of 0.2.x was removed in 0.3: only TABCAP_* is read.

export const ENV_PREFIX = "TABCAP_";

/** TABCAP_<name>; empty strings count as set. */
export function envVar(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[ENV_PREFIX + name];
}
