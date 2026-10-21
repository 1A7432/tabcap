// Argument accessors for the daemon API. Args arrive as JSON from the CLI (or
// any local client), so they are validated like any other external input.

import { TabcapError } from "../../shared/envelope.ts";

export type Args = Record<string, unknown>;

const bad = (name: string, want: string) => new TabcapError("usage", `argument ${name} must be ${want}`, "Run `tabcap <command> --help` for the expected arguments.");

export function optStr(a: Args, name: string): string | null {
  const v = a[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw bad(name, "a string");
  return v;
}

export function reqStr(a: Args, name: string, usage: string): string {
  const v = optStr(a, name);
  if (v === null || v === "") throw new TabcapError("usage", `missing ${name}`, `Usage: ${usage}`);
  return v;
}

/** A repeatable string flag: absent → [], else one string or a list of strings. */
export function optStrList(a: Args, name: string): string[] {
  const v = a[name];
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) throw bad(name, "a string or a list of strings");
  return v;
}

export function optBool(a: Args, name: string): boolean {
  const v = a[name];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw bad(name, "true or false");
  return v;
}

export function optNum(a: Args, name: string): number | null {
  const v = a[name];
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw bad(name, "a number");
  return n;
}

const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function checkSessionName(name: string): string {
  if (!SESSION_NAME.test(name)) throw new TabcapError("usage", `bad session name: ${JSON.stringify(name)}`, "Session names use letters, digits, '.', '_' or '-' (max 64).");
  return name;
}
