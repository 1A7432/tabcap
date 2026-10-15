// Time helpers for the evidence bundle (docs/04 §3, §6).
// - `ts`   : wall clock, epoch milliseconds (number, may carry a fraction).
// - `mono` : CDP monotonic clock in milliseconds; only used for durations.
// CDP reports `wallTime` (TimeSinceEpoch) and `timestamp` (MonotonicTime)
// in seconds; both are converted to milliseconds here.

/** Daemon wall clock in epoch milliseconds. */
export function nowMs(): number {
  return Date.now();
}

/** Round to microsecond precision to drop float noise from seconds*1000. */
function roundMicros(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** CDP `wallTime` (seconds since epoch) -> spec `ts` (epoch ms). */
export function wallTimeToTs(wallTimeSeconds: number): number {
  return roundMicros(wallTimeSeconds * 1000);
}

/** CDP MonotonicTime (seconds) -> spec `mono` (ms). */
export function monotonicToMono(seconds: number): number {
  return roundMicros(seconds * 1000);
}

/** Spec `ts` -> ISO 8601 (HAR startedDateTime). */
export function tsToIso(ts: number): string {
  return new Date(ts).toISOString();
}

/** ISO 8601 -> epoch ms, or null when unparsable. */
export function isoToTs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Local `YYYYMMDD-HHMMSS`, used for default bundle / export names. */
export function compactStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
