// Per-host pacing of `tabcap fetch` (0.6-A, owner red line: ≥ 3 s between
// requests by default, no way around it from the command line). Requests to
// one host are admitted in arrival order (FIFO); one may start when fewer than
// `concurrency` are in flight and at least `minIntervalMs` passed since the
// last request to that host started or finished, whichever is later. With the
// default concurrency 1 that is a gap of minIntervalMs between the end of one
// request and the start of the next. The clock is injected (unit tests use a
// fake one).

import { TabcapError } from "../../shared/envelope.ts";

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
export const REAL_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export type Pace = { minIntervalMs: number; concurrency: number };

type HostState = { inFlight: number; last: number | null; chain: Promise<void>; released: Array<() => void> };

/** `cancel` (owner 10-21): the request was not sent after all; the turn goes back (the host's last start is what it was). */
export type Slot = { waitedMs: number; release: () => void; cancel: () => void };

export class HostLimiter {
  private hosts = new Map<string, HostState>();

  constructor(private readonly clock: Clock = REAL_CLOCK) {}

  private state(host: string): HostState {
    let st = this.hosts.get(host);
    if (st === undefined) {
      st = { inFlight: 0, last: null, chain: Promise.resolve(), released: [] };
      this.hosts.set(host, st);
    }
    return st;
  }

  /** In flight now for a host (tests, status). */
  inFlight(host: string): number {
    return this.hosts.get(host)?.inFlight ?? 0;
  }

  /**
   * Wait for this host's turn. Rejects with `timeout` (nothing sent) when the
   * turn would come after `deadline`; the queue moves on without it.
   */
  async acquire(host: string, pace: Pace, deadline: number): Promise<Slot> {
    const st = this.state(host);
    const started = this.clock.now();
    const prev = st.chain;
    let admitted: () => void = () => undefined;
    let before: number | null = null;
    let mine = 0;
    st.chain = new Promise<void>((r) => (admitted = r));
    try {
      await prev;
      for (;;) {
        const now = this.clock.now();
        if (st.inFlight < Math.max(1, pace.concurrency)) {
          const due = st.last === null ? now : st.last + pace.minIntervalMs;
          if (now >= due) break;
          if (due > deadline) throw tooLate(host, due - started, pace);
          await this.clock.sleep(due - now);
          continue;
        }
        if (now >= deadline) throw tooLate(host, now - started, pace);
        // A request in flight: wait for a release (or the deadline).
        let wake: () => void = () => undefined;
        const released = new Promise<void>((r) => (wake = r));
        st.released.push(wake);
        await Promise.race([released, this.clock.sleep(deadline - now)]);
        st.released = st.released.filter((w) => w !== wake);
      }
      st.inFlight++;
      before = st.last;
      st.last = mine = this.clock.now();
    } finally {
      admitted();
    }
    let done = false;
    const end = (sent: boolean) => {
      if (done) return;
      done = true;
      st.inFlight--;
      if (sent) st.last = this.clock.now();
      else if (st.last === mine) st.last = before;
      for (const w of st.released.splice(0)) w();
    };
    return { waitedMs: this.clock.now() - started, release: () => end(true), cancel: () => end(false) };
  }
}

function tooLate(host: string, waitMs: number, pace: Pace): TabcapError {
  return new TabcapError(
    "timeout",
    `the request to ${host} would wait about ${Math.round(waitMs)} ms for its turn (fetch.minIntervalMs ${pace.minIntervalMs}, concurrency ${pace.concurrency}), past --timeout; nothing was sent`,
    "Raise --timeout (it covers the wait for the turn), or send fewer requests to this host at once.",
  );
}
