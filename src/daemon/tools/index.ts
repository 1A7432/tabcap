// Action registry of the daemon API: POST /command {action, args, session}.

import type { Daemon } from "../state.ts";
import type { Args } from "./args.ts";
import { browserStart, browserStatus, browserStop } from "./browser.ts";
import { consoleList, consoleShow } from "./console.ts";
import { emulate, resize } from "./device.ts";
import { click, fill, hover, press, typeText, upload } from "./input.ts";
import { guardResume, handoffContinue, handoffStatus } from "./handoff.ts";
import { fetchTool, type ToolCtx } from "./fetch.ts";
import { go, navigate, reload } from "./navigate.ts";
import { netBody, netGrepTool, netList, netShow, netStart, netStop } from "./net.ts";
import { html } from "./html.ts";
import { dialog, evaluate, screenshot } from "./page.ts";
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

/** `ctx.cmd`: the command window (`c-<seq>`) the daemon opened for this call, when recording. */
export type Tool = (d: Daemon, a: Args, session: string, ctx?: ToolCtx) => Promise<unknown> | unknown;

export const TOOLS: Record<string, Tool> = {
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
