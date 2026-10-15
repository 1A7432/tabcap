// Minimal leveled logger. Writes to stderr only, so stdout stays a clean
// JSON envelope. Level comes from TABCAP_LOG (debug|info|warn|error|silent).

import { envVar } from "./env.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function parseLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return value;
    default:
      return "warn";
  }
}

let current: LogLevel = parseLevel(envVar("LOG"));

export function setLogLevel(level: LogLevel): void {
  current = level;
}

let scrubber: ((line: string) => string) | null = null;

/** The daemon installs known-secret replacement here (docs/04 §8.1): every line passes through it. */
export function setLogScrubber(fn: ((line: string) => string) | null): void {
  scrubber = fn;
}

function emit(level: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[current]) return;
  const tail = fields === undefined ? "" : " " + JSON.stringify(fields);
  const line = `[tabcap ${level}] ${msg}${tail}\n`;
  process.stderr.write(scrubber === null ? line : scrubber(line));
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
