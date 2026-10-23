// Action registry of the daemon API: POST /command {action, args, session}.

import type { Daemon } from "../state.ts";
import type { Args } from "./args.ts";
import { browserStart, browserStatus, browserStop } from "./browser.ts";
import { consoleList, consoleShow } from "./console.ts";
import { emulate, resize } from "./device.ts";
import { click, fill, hover, press, typeText, upload } from "./input.ts";
import { e2eHumanInput, guardResume, handoffContinue, handoffStatus } from "./handoff.ts";
import { handoffWait } from "./handoffwait.ts";
import { fetchTool, type ToolCtx } from "./fetch.ts";
import { go, navigate, reload } from "./navigate.ts";
import { netBody, netGrepTool, netList, netShow, netStart, netStop } from "./net.ts";
import { html } from "./html.ts";
import { dialog, evaluate, screenshot } from "./page.ts";
import { permission } from "./permission.ts";
import { sessionList, sessionStart, sessionStop, tabClose, tabUse, tabsList } from "./session.ts";
import { sessionExport } from "./sessionexport.ts";
import { find, snapshot } from "./snapshot.ts";
import { outline } from "./outline.ts";
import { netWait, wait } from "./wait.ts";
import { where } from "./where.ts";
import { recon } from "./recon.ts";
import { traceList, traceStart, traceStatus, traceStop } from "./trace.ts";
import { fingerprintProbe } from "./fingerprint.ts";
import { wireProbe, wireProfile } from "./wire.ts";
import type { ToolAction } from "./registry.ts";

/** `ctx.cmd`: the command window (`c-<seq>`) the daemon opened for this call, when recording. */
export type Tool = (d: Daemon, a: Args, session: string, ctx?: ToolCtx) => Promise<unknown> | unknown;

/** Keyed by tools/registry.ts TOOL_ACTIONS: a tool without its metadata row (or a row without a tool) does not compile. */
const TABLE: Record<ToolAction, Tool> = {
  "browser.start": (d, a) => browserStart(d, a),
  "browser.stop": (d) => browserStop(d),
  "browser.status": (d) => browserStatus(d),
  "session.start": (d, a) => sessionStart(d, a),
  "session.stop": (d, a) => sessionStop(d, a),
  "session.list": (d) => sessionList(d),
  "session.export": sessionExport,
  navigate,
  tabs: tabsList,
  "tab.close": tabClose,
  "tab.use": tabUse,
  go,
  reload,
  snapshot,
  outline,
  find,
  html,
  click,
  hover,
  fill,
  type: typeText,
  press,
  upload,
  evaluate,
  screenshot,
  resize,
  emulate,
  permission,
  dialog,
  "net.start": netStart,
  "net.stop": netStop,
  "net.list": netList,
  "net.body": netBody,
  "net.show": netShow,
  "net.grep": netGrepTool,
  "console.list": consoleList,
  "console.show": consoleShow,
  wait,
  "net.wait": netWait,
  "handoff.status": handoffStatus,
  "handoff.continue": handoffContinue,
  "handoff.wait": handoffWait,
  // 0.7.1-A test-only: refused unless the daemon started with TABCAP_E2E_HUMAN=1 (docs/04 §37).
  "e2e.human-input": e2eHumanInput,
  "guard.resume": guardResume,
  fetch: fetchTool,
  where,
  recon,
  "trace.start": traceStart,
  "trace.stop": traceStop,
  "trace.status": traceStatus,
  "trace.list": traceList,
  "fingerprint.probe": fingerprintProbe,
  "wire.profile": wireProfile,
  "wire.probe": wireProbe,
};

export const TOOLS: Readonly<Record<string, Tool>> = TABLE;
