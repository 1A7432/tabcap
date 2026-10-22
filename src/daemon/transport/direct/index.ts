// `direct` transport: our own Chrome for Testing over pipe (or port), with the
// auto-attach protocol. Focus-stealing CDP methods are refused here so no AI
// command path reaches them by accident (docs/07 §1.1 focus ladder: level 3 is
// for the human); `bringToFront` is the one explicit door, for
// `tab select --bring-to-front` (docs/08 §5).

import type { ChildProcess } from "node:child_process";
import { TabcapError } from "../../../shared/envelope.ts";
import { isRecord, str } from "../../../shared/json.ts";
import { log } from "../../../shared/log.ts";
import type { AttachHook, AttachedTarget, CdpEvent, CdpParams, CdpResult, Transport } from "../types.ts";
import { AutoAttacher } from "./attach.ts";
import { CdpClient, CdpError } from "./cdp.ts";
import { FrontGuard, type FrontStats } from "./front.ts";
import { InputWindows } from "../inputwindows.ts";
import {
  activateApp,
  activateAppAsync,
  frontmostApp,
  frontmostAppAsync,
  isChromeApp,
  killAndWait,
  launchChrome,
  type CustomArgs,
  type ProxyMode,
  type WebdriverMode,
} from "./launcher.ts";

export const FORBIDDEN_METHODS = new Set(["Target.activateTarget", "Page.bringToFront"]);

export type DirectOptions = {
  executable: string;
  profileDir: string;
  logFile: string;
  proxy: ProxyMode;
  webdriver: WebdriverMode;
  /** 0.8.1-A: custom Chrome args (docs/04 §42). */
  custom: CustomArgs;
  extensionDir: string | null;
  noStartupWindow: boolean;
  cdp?: "pipe" | "port";
  /** Hand the macOS foreground back to the app that had it before launch. */
  restoreFront: boolean;
};

export type FrontReport = {
  before: string | null;
  beforeBundleId: string | null;
  afterLaunch: string | null;
  restored: boolean | null;
  after: string | null;
  noStartupWindow: boolean;
};

export class DirectTransport implements Transport {
  readonly kind = "direct" as const;
  readonly closed: Promise<string>;
  /** Focus-stealing calls refused so far (audit, docs/06 A1.1). */
  refusedFocusCalls = 0;
  /** Explicit level-3 calls (`tab select --bring-to-front`) made so far. */
  allowedFocusCalls = 0;
  /** Target.createTarget calls in flight: page targets appearing meanwhile are ours (background tabs, no focus change). */
  private ownCreates = 0;
  /** 0.7.1-A: one window per `Input.*` command sent through `send` (docs/04 §37). */
  readonly inputWindows = new InputWindows();

  private constructor(
    readonly cdp: CdpClient,
    private readonly attacher: AutoAttacher,
    readonly proc: ChildProcess,
    readonly pid: number,
    readonly channel: "pipe" | "port",
    readonly version: { product: string; userAgent: string },
    readonly front: FrontReport,
    readonly args: string[],
    /** Custom drops that matched nothing (docs/04 §42). */
    readonly unmatchedDrops: string[],
    readonly frontGuard: FrontGuard,
  ) {
    this.closed = cdp.closed;
    // Page-opened windows / foreground tabs take the macOS foreground (front.ts).
    cdp.on((e) => {
      if (e.method !== "Target.targetCreated") return;
      const info = isRecord(e.params["targetInfo"]) ? e.params["targetInfo"] : null;
      if (info === null || str(info, "type") !== "page") return;
      if (str(info, "openerId") === null && this.ownCreates > 0) return;
      void this.frontGuard.onNewWindow();
    });
  }

  static async start(o: DirectOptions): Promise<DirectTransport> {
    const beforeApp = frontmostApp();
    const probe: { wire: unknown; client: CdpClient | null } = { wire: null, client: null };
    const launched = await launchChrome({
      executable: o.executable,
      profileDir: o.profileDir,
      logFile: o.logFile,
      platform: process.platform,
      proxy: o.proxy,
      webdriver: o.webdriver,
      custom: o.custom,
      extensionDir: o.extensionDir,
      noStartupWindow: o.noStartupWindow,
      ...(o.cdp === undefined ? {} : { cdp: o.cdp }),
      probe: async (wire) => {
        const client = new CdpClient(wire);
        probe.wire = wire;
        probe.client = client;
        return client.send("Browser.getVersion", {}, null, 10_000).then(
          () => true,
          () => false,
        );
      },
    });
    // Reuse the client that probed the pipe; the port path gets a fresh one.
    const cdp = probe.client !== null && probe.wire === launched.wire ? probe.client : new CdpClient(launched.wire);
    launched.proc.once("exit", (code, signal) => {
      log.info("browser exited", { code, signal });
      cdp.close();
    });
    const attacher = new AutoAttacher(cdp);
    let version = { product: "", userAgent: "" };
    try {
      const v = await cdp.send("Browser.getVersion");
      version = { product: str(v, "product") ?? "", userAgent: str(v, "userAgent") ?? "" };
      await attacher.start();
    } catch (e) {
      await killAndWait(launched.proc, 3000);
      throw new TabcapError("internal", `browser started but CDP setup failed: ${e instanceof Error ? e.message : String(e)}`, `Check ${o.logFile}.`);
    }
    // Chrome takes the macOS foreground when it starts (docs/07 §1.1). Give it a
    // moment to do so, then hand the foreground back.
    let afterLaunch: string | null = null;
    let restored: boolean | null = null;
    if (process.platform === "darwin" && beforeApp !== null) {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        afterLaunch = frontmostApp()?.name ?? null;
        if (isChromeApp(afterLaunch)) break;
        await Bun.sleep(100);
      }
      // Chrome may re-activate itself shortly after we hand the foreground back
      // (measured once with a startup window), so check again a few times.
      if (o.restoreFront && !isChromeApp(beforeApp)) {
        for (let i = 0; i < 4 && isChromeApp(frontmostApp()); i++) {
          restored = activateApp(beforeApp);
          await Bun.sleep(400);
        }
      }
    }
    // Handing the foreground back uses osascript, which only exists on macOS.
    if (process.platform !== "darwin" && o.restoreFront) log.info("foreground hand-back is macOS-only; skipped", { platform: process.platform });
    const front: FrontReport = { before: beforeApp?.name ?? null, beforeBundleId: beforeApp?.bundleId ?? null, afterLaunch, restored, after: frontmostApp()?.name ?? null, noStartupWindow: o.noStartupWindow };
    const guard = new FrontGuard(
      isChromeApp(beforeApp) ? null : beforeApp,
      { read: frontmostAppAsync, activate: activateAppAsync, sleep: (ms) => Bun.sleep(ms), now: () => Date.now() },
      o.restoreFront && process.platform === "darwin",
    );
    return new DirectTransport(cdp, attacher, launched.proc, launched.pid, launched.cdp, version, front, launched.args, launched.unmatchedDrops, guard);
  }

  send(method: string, params: CdpParams = {}, sessionId: string | null = null, timeoutMs?: number): Promise<CdpResult> {
    if (FORBIDDEN_METHODS.has(method)) {
      this.refusedFocusCalls++;
      return Promise.reject(
        new TabcapError("unsupported", `${method} is refused: it would steal focus from the user`, "Use `--trusted` (focus emulation) instead; the human can bring the window to front themselves."),
      );
    }
    if (method === "Target.createTarget") {
      this.ownCreates++;
      // targetCreated normally arrives before the reply; keep the window open a little longer anyway.
      return this.cdp.send(method, params, sessionId, timeoutMs).finally(() => {
        setTimeout(() => this.ownCreates--, 500);
      });
    }
    if (method.startsWith("Input.")) {
      // 0.7.1-A: tabcap's own input is trusted in the page; the take-over listener skips this window.
      const w = this.inputWindows.begin(sessionId ?? "");
      return this.cdp.send(method, params, sessionId, timeoutMs).finally(() => this.inputWindows.end(w));
    }
    return this.cdp.send(method, params, sessionId, timeoutMs);
  }

  /**
   * Focus ladder level 3 (docs/07 §1.1): Page.bringToFront, which takes the
   * macOS foreground and activates the tab. The only way past FORBIDDEN_METHODS,
   * used by `tab select --bring-to-front` alone, i.e. when asked for explicitly.
   */
  async bringToFront(sessionId: string): Promise<void> {
    this.allowedFocusCalls++;
    await this.cdp.send("Page.bringToFront", {}, sessionId, 10_000);
  }

  /** Record which macOS app is frontmost now (after each command), for handing the foreground back. */
  noteFront(): void {
    void this.frontGuard.note().catch(() => undefined);
  }

  get frontStats(): FrontStats & { lastSeen: string | null; lastSeenBundleId: string | null } {
    return { ...this.frontGuard.stats, lastSeen: this.frontGuard.lastSeen?.name ?? null, lastSeenBundleId: this.frontGuard.lastSeen?.bundleId ?? null };
  }

  onEvent(fn: (e: CdpEvent) => void): () => void {
    return this.cdp.on(fn);
  }

  onAttach(hook: AttachHook): () => void {
    return this.attacher.addHook(hook);
  }

  onDetach(fn: (t: AttachedTarget) => void): () => void {
    return this.attacher.onDetach(fn);
  }

  targets(): AttachedTarget[] {
    return this.attacher.list();
  }

  async attach(targetId: string): Promise<AttachedTarget> {
    const known = this.attacher.byTarget(targetId);
    if (known !== undefined) return known;
    await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    return this.waitAttached(targetId, 10_000);
  }

  async detach(sessionId: string): Promise<void> {
    await this.cdp.send("Target.detachFromTarget", { sessionId }).catch((e: unknown) => {
      if (!(e instanceof CdpError)) throw e;
    });
  }

  async waitAttached(targetId: string, timeoutMs: number): Promise<AttachedTarget> {
    const t = await this.attacher.waitReady(targetId, timeoutMs);
    if (t === null) throw new TabcapError("timeout", `target ${targetId} did not attach within ${timeoutMs} ms`, "Retry; if it keeps failing run `tabcap browser stop` and `tabcap browser start`.");
    return t;
  }

  /** Browser.close, then SIGTERM / SIGKILL if the process lingers. */
  async shutdown(): Promise<void> {
    if (!this.cdp.isClosed) await this.cdp.send("Browser.close", {}, null, 3000).catch(() => undefined);
    const exited = this.proc.exitCode !== null || this.proc.signalCode !== null;
    if (!exited) {
      const gone = await Promise.race([new Promise<boolean>((r) => this.proc.once("exit", () => r(true))), Bun.sleep(5000).then(() => false)]);
      if (!gone) await killAndWait(this.proc, 3000);
    }
    this.cdp.close();
  }

  /** 0.8.2 (docs/04 §18): the shutdown ran out of time; the browser goes now, its process does not outlive the daemon. */
  async kill(): Promise<void> {
    await killAndWait(this.proc, 0);
    this.cdp.close();
  }
}
