// `handoff wait --until-url`: the answer's `condition` carries the handoff tab's
// URL when the condition held. It is live output (docs/04 §8.3, review 10-21):
// its sensitive-named query values are shown as <redacted:name>, like the
// handoff view's own `url`; the rest of the URL is unchanged. Cookie
// conditions carry no detail, text conditions their frame. Oracle: the rule
// table of docs/04 §8 (`token`, `sid` are sensitive names; `page` is not).

import { describe, expect, test } from "bun:test";
import { conditionView } from "../../src/daemon/tools/handoffwait.ts";

describe("handoff wait: the condition in the answer", () => {
  test("url: the tab URL with sensitive query values redacted", () => {
    expect(conditionView({ kind: "url", value: "/home", key: "url:/home" }, { url: "https://shop.example/home?token=abc123&page=2&sid=s-9#top" })).toEqual({
      kind: "url",
      value: "/home",
      url: "https://shop.example/home?token=<redacted:token>&page=2&sid=<redacted:sid>#top",
    });
    expect(conditionView({ kind: "url", value: "/home", key: "url:/home" }, { url: "https://shop.example/home" })).toEqual({ kind: "url", value: "/home", url: "https://shop.example/home" });
  });

  test("cookie: name only; text: the detail as is", () => {
    expect(conditionView({ kind: "cookie", value: "sid", key: "cookie:sid" }, { url: "https://x.example/?token=t" })).toEqual({ kind: "cookie", value: "sid" });
    expect(conditionView({ kind: "text", value: "Welcome", key: "text:Welcome" }, { text: "Welcome", frame: null })).toEqual({ kind: "text", value: "Welcome", text: "Welcome", frame: null });
  });
});
