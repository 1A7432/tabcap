// tabcap's own input windows (0.7.1-A, docs/04 §37). Every CDP `Input.*`
// command the daemon sends opens a window on its CDP session (= the tab) when
// it goes out and closes it when the answer (or an error, or a timeout) comes
// back. The take-over listener ignores trusted input that reaches the daemon
// inside a window of the same tab or within INPUT_GRACE_MS after it closed:
// tabcap's own CDP input is isTrusted:true in the page, and a `wheel` from
// `mouseWheel` arrives ~5 ms after the answer (docs/07 §1.1, spike-071a).

/** How long after an `Input.*` answer a trusted event is still tabcap's own. */
export const INPUT_GRACE_MS = 500;
/** Closed windows older than this are dropped (well past the grace). */
export const INPUT_KEEP_MS = 5000;

/** `key` is the CDP session the command went to; `end` is null while the command is in flight. */
export type InputWindow = { key: string; start: number; end: number | null };

/** Pure: does a window of `key` cover an event that reached the daemon at `at`? */
export function coveredBy(windows: readonly InputWindow[], key: string, at: number, graceMs = INPUT_GRACE_MS): boolean {
  return windows.some((w) => w.key === key && at >= w.start && (w.end === null || at <= w.end + graceMs));
}

export class InputWindows {
  private readonly open = new Map<number, InputWindow>();
  private closed: InputWindow[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A command goes out on `key`; returns the id `end` takes. */
  begin(key: string): number {
    const id = ++this.seq;
    this.open.set(id, { key, start: this.now(), end: null });
    return id;
  }

  /** Its answer (or error) came back. Unknown ids are ignored. */
  end(id: number): void {
    const w = this.open.get(id);
    if (w === undefined) return;
    this.open.delete(id);
    w.end = this.now();
    this.closed.push(w);
    this.prune();
  }

  /** Open windows and the closed ones that can still matter. */
  list(): InputWindow[] {
    this.prune();
    return [...this.open.values(), ...this.closed];
  }

  /** True when an event of `key` that reached the daemon now is tabcap's own input. */
  covers(key: string, at: number = this.now()): boolean {
    return coveredBy(this.list(), key, at);
  }

  private prune(): void {
    const cut = this.now() - INPUT_KEEP_MS;
    if (this.closed.length > 0 && (this.closed[0]?.end ?? cut) < cut) this.closed = this.closed.filter((w) => (w.end ?? Number.POSITIVE_INFINITY) >= cut);
  }
}
