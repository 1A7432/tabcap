// macOS foreground guard for page-opened windows (docs/07 §1.1, docs/05 s17).
// Measured 10-15 on Chrome for Testing 155: a click whose handler calls
// `window.open` makes Chrome the frontmost macOS app within ~150 ms — with a
// features string (new window) and without one (new foreground tab in the
// opener's window) alike, and with no CDP focus call involved. The field report
// saw the same after ~0.8 s. Launch has the same problem; both hand the
// foreground back with `osascript activate`, retried because Chrome may
// re-activate itself shortly after.
//
// Which app to hand it back to: the frontmost app read when the window appears
// if Chrome has not taken over yet, else the last reading taken after a command
// (or at launch). When that reading was Chrome itself the human is working in
// the tabcap browser, and nothing is restored.
//
// Whose window it is (owner 2026-11-06, field report: focus yanked back to the
// terminal four times while the human typed in a tabcap tab): only a window
// that appears while a page-acting command (click, press, evaluate …) runs, or
// within `commandGraceMs` after one ended, is tabcap's and handed back. Any
// other window was opened by the human working in the browser (a link, a
// popup, Cmd+T), and so is one whose opener tab belongs to a session waiting
// for the human (`human`); neither is touched.

import { isChromeApp, type FrontApp } from "./launcher.ts";

export type FrontOps = {
  read: () => Promise<FrontApp | null>;
  activate: (app: FrontApp) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type RestoreOptions = {
  /** Keep watching this long after the window appeared. */
  watchMs: number;
  /** And at least this long after the last hand-back. */
  settleMs: number;
  pollMs: number;
  maxAttempts: number;
  /** A window this long after a page-acting command ended is still that command's. */
  commandGraceMs: number;
};

export const RESTORE_DEFAULTS: RestoreOptions = { watchMs: 2500, settleMs: 1200, pollMs: 100, maxAttempts: 4, commandGraceMs: 1500 };

export type RestoreReport = {
  before: string;
  beforeBundleId: string | null;
  /** Chrome was seen frontmost during the watch. */
  stolen: boolean;
  /** null: nothing was stolen, so nothing was attempted. */
  restored: boolean | null;
  attempts: number;
  after: string | null;
};

/** Watch the frontmost app; whenever Chrome has it, activate `before` again (bounded). */
export async function restoreFront(before: FrontApp, ops: FrontOps, o: RestoreOptions = RESTORE_DEFAULTS): Promise<RestoreReport> {
  let until = ops.now() + o.watchMs;
  let stolen = false;
  let attempts = 0;
  let after: FrontApp | null = null;
  while (ops.now() < until) {
    after = await ops.read();
    if (isChromeApp(after)) {
      stolen = true;
      if (attempts >= o.maxAttempts) break;
      attempts++;
      await ops.activate(before);
      until = Math.max(until, ops.now() + o.settleMs);
    }
    await ops.sleep(o.pollMs);
  }
  after = await ops.read();
  return { before: before.name, beforeBundleId: before.bundleId, stolen, restored: stolen ? !isChromeApp(after) : null, attempts, after: after?.name ?? null };
}

/** `human`: windows the human opened (no page-acting command around, or the opener's session waits for the human): never handed back. */
export type FrontStats = { windows: number; human: number; stolen: number; restored: number; failed: number; skipped: number; last: RestoreReport | null };

export class FrontGuard {
  readonly stats: FrontStats = { windows: 0, human: 0, stolen: 0, restored: 0, failed: 0, skipped: 0, last: null };
  private baseline: FrontApp | null;
  private running: Promise<void> | null = null;
  private again = false;
  private pageCommands = 0;
  private lastCommandEnd = -Infinity;

  constructor(
    launchBefore: FrontApp | null,
    private readonly ops: FrontOps,
    private readonly enabled: boolean,
    private readonly opts: RestoreOptions = RESTORE_DEFAULTS,
  ) {
    this.baseline = launchBefore;
  }

  /** The last frontmost-app reading used as the hand-back target. */
  get lastSeen(): FrontApp | null {
    return this.baseline;
  }

  /** After a command: remember the frontmost app (skipped while a window is being handled). */
  async note(): Promise<void> {
    if (!this.enabled || this.running !== null) return;
    const seen = this.stats.windows;
    const app = await this.ops.read();
    // A window appeared while we read: the reading may already be Chrome's steal.
    if (app === null || this.running !== null || this.stats.windows !== seen) return;
    this.baseline = app;
  }

  /** A page-acting command begins: windows from now until `commandGraceMs` after its end are tabcap's. */
  commandStart(): Promise<void> {
    this.pageCommands++;
    // The human may have switched apps since the last command: the hand-back target is read afresh.
    return this.note().catch(() => undefined);
  }

  commandEnd(): void {
    this.pageCommands = Math.max(0, this.pageCommands - 1);
    this.lastCommandEnd = this.ops.now();
  }

  private tabcapCaused(): boolean {
    return this.pageCommands > 0 || this.ops.now() - this.lastCommandEnd <= this.opts.commandGraceMs;
  }

  /**
   * A page target we did not create appeared (popup, new window, foreground tab). `human`: its opener
   * tab belongs to a session waiting for the human.
   */
  onNewWindow(o: { human?: boolean } = {}): Promise<void> {
    this.stats.windows++;
    if (!this.enabled) return Promise.resolve();
    if (o.human === true || !this.tabcapCaused()) {
      this.stats.human++;
      return this.running ?? Promise.resolve();
    }
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    const run = async () => {
      do {
        this.again = false;
        await this.handle();
      } while (this.again);
    };
    this.running = run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Resolves when no hand-back is in progress (tests, shutdown). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async handle(): Promise<void> {
    const cur = await this.ops.read();
    if (cur !== null && !isChromeApp(cur)) this.baseline = cur; // Chrome has not taken over yet
    const before = this.baseline;
    if (before === null || isChromeApp(before)) {
      this.stats.skipped++;
      return;
    }
    const r = await restoreFront(before, this.ops, this.opts);
    this.stats.last = r;
    if (r.stolen) this.stats.stolen++;
    if (r.restored === true) this.stats.restored++;
    if (r.restored === false) this.stats.failed++;
  }
}
