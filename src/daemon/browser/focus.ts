// Focus ladder (docs/07 §1.1, adopted 10-15):
//   level 1  DOM: el.click() / value setter via Runtime — no focus change, isTrusted:false;
//   level 2  Emulation.setFocusEmulationEnabled for the duration of one command,
//            then CDP Input.* (isTrusted:true). The page turns `visible` meanwhile;
//            emulation is switched off right after (with its own short timeout);
//   level 3  Page.bringToFront — refused in transport on every AI command path;
//            only `tab select --bring-to-front` asks for it, explicitly.

import type { Transport } from "../transport/types.ts";
import { log } from "../../shared/log.ts";

export async function withFocusEmulation<T>(t: Transport, sessionId: string, fn: () => Promise<T>): Promise<T> {
  await t.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId, 3000);
  try {
    return await fn();
  } finally {
    await t.send("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId, 1000).catch((e: unknown) => {
      log.warn("focus emulation did not switch off", { error: String(e) });
    });
  }
}
