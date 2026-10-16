// Action registry of the daemon API: POST /command {action, args, session}.

import type { Daemon } from "../state.ts";
import type { Args } from "./args.ts";
import { browserStart, browserStatus, browserStop } from "./browser.ts";
import { consoleList, consoleShow } from "./console.ts";
import { emulate, resize } from "./device.ts";
import { click, fill, hover, press, typeText, upload } from "./input.ts";
import { handoffContinue, handoffStatus } from "./handoff.ts";
import { go, navigate, reload } from "./navigate.ts";
import { netBody, netList, netShow, netStart, netStop } from "./net.ts";
import { dialog, evaluate, screenshot } from "./page.ts";
import { sessionList, sessionStart, sessionStop, tabClose, tabUse, tabsList } from "./session.ts";
import { find, snapshot } from "./snapshot.ts";
import { outline } from "./outline.ts";
import { netWait, wait } from "./wait.ts";
import { where } from "./where.ts";
import { traceList, traceStart, traceStatus, traceStop } from "./trace.ts";
import { fingerprintProbe } from "./fingerprint.ts";

export type Tool = (d: Daemon, a: Args, session: string) => Promise<unknown> | unknown;

export const TOOLS: Record<string, Tool> = {
  "browser.start": (d, a) => browserStart(d, a),
  "browser.stop": (d) => browserStop(d),
  "browser.status": (d) => browserStatus(d),
  "session.start": (d, a) => sessionStart(d, a),
  "session.stop": (d, a) => sessionStop(d, a),
  "session.list": (d) => sessionList(d),
  navigate,
  tabs: tabsList,
  "tab.close": tabClose,
  "tab.use": tabUse,
  go,
  reload,
  snapshot,
  outline,
  find,
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
  "console.list": consoleList,
  "console.show": consoleShow,
  wait,
  "net.wait": netWait,
  "handoff.status": handoffStatus,
  "handoff.continue": handoffContinue,
  where,
  "trace.start": traceStart,
  "trace.stop": traceStop,
  "trace.status": traceStatus,
  "trace.list": traceList,
  "fingerprint.probe": fingerprintProbe,
};
