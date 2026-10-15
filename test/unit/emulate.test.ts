// `tabcap emulate` arguments (docs/08 §5; parameter set and semantics after
// chrome-devtools-mcp emulate, presets from Puppeteer — see NOTICE).

import { describe, expect, test } from "bun:test";
import { emulationCalls, geolocationTransform, networkMultiplier, parseEmulate, PredefinedNetworkConditions, viewportTransform } from "../../src/daemon/tools/emulatespec.ts";
import { parseSize } from "../../src/daemon/tools/device.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const usage = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof TabcapError ? e.code : "other";
  }
  return "none";
};

describe("emulate parsing", () => {
  test("viewport: WxH[xDPR][,mobile][,touch][,landscape]", () => {
    expect(viewportTransform("1280x800")).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false });
    expect(viewportTransform("390x844x3,mobile,touch")).toEqual({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false });
    expect(viewportTransform("844x390x2.5,landscape")).toMatchObject({ deviceScaleFactor: 2.5, isLandscape: true });
    for (const bad of ["", "x", "0x10", "10x0", "10", "10x10x0", "10x10x-1", "10.5x10", "axb", "10x10,phone", "10x10x2x3", "-5x10"]) expect([bad, usage(() => viewportTransform(bad))]).toEqual([bad, "usage"]);
  });

  test("geolocation: lat,lon in range", () => {
    expect(geolocationTransform("52.52,13.40")).toEqual({ latitude: 52.52, longitude: 13.4 });
    expect(geolocationTransform("-90,180")).toEqual({ latitude: -90, longitude: 180 });
    for (const bad of ["", "1", "91,0", "0,181", "a,b", "1,2,3", ",1"]) expect([bad, usage(() => geolocationTransform(bad))]).toEqual([bad, "usage"]);
  });

  test("a call carries only what it sets: everything else is cleared", () => {
    expect(parseEmulate({})).toEqual({});
    expect(parseEmulate({ colorScheme: "auto", userAgent: "", cpuThrottlingRate: 1 })).toEqual({});
    expect(parseEmulate({ viewport: "100x200", colorScheme: "dark", networkConditions: "slow 3g", cpuThrottlingRate: 4, userAgent: "UA/1", geolocation: "1,2" })).toEqual({
      viewport: { width: 100, height: 200, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
      colorScheme: "dark",
      networkConditions: "Slow 3G",
      cpuThrottlingRate: 4,
      userAgent: "UA/1",
      geolocation: { latitude: 1, longitude: 2 },
    });
    expect(usage(() => parseEmulate({ colorScheme: "blue" }))).toBe("usage");
    expect(usage(() => parseEmulate({ networkConditions: "5G" }))).toBe("usage");
    expect(usage(() => parseEmulate({ cpuThrottlingRate: 0.5 }))).toBe("usage");
    expect(usage(() => parseEmulate({ cpuThrottlingRate: 21 }))).toBe("usage");
    expect(usage(() => parseEmulate({ cpuThrottlingRate: "fast" }))).toBe("usage");
    expect(usage(() => parseEmulate({ viewport: 5 }))).toBe("usage");
  });

  test("CDP calls: every setting is sent, cleared ones with their reset value", () => {
    const off = emulationCalls({});
    expect(off.map((c) => c.method)).toEqual([
      "Network.overrideNetworkState",
      "Network.emulateNetworkConditionsByRule",
      "Emulation.setCPUThrottlingRate",
      "Emulation.clearGeolocationOverride",
      "Emulation.setUserAgentOverride",
      "Emulation.setEmulatedMedia",
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
    ]);
    expect(off[0]?.params).toEqual({ offline: false, latency: 0, uploadThroughput: -1, downloadThroughput: -1 });
    expect(off[2]?.params).toEqual({ rate: 1 });
    expect(off[4]?.params).toEqual({ userAgent: "" });
    expect(off[5]?.params).toEqual({ features: [{ name: "prefers-color-scheme", value: "" }] });
    const on = emulationCalls(parseEmulate({ viewport: "844x390x2,mobile,touch,landscape", networkConditions: "Fast 4G", geolocation: "1,2" }));
    const slow = PredefinedNetworkConditions["Fast 4G"];
    expect(on[1]?.params).toEqual({ matchedNetworkConditions: [{ urlPattern: "", offline: false, latency: slow.latency, downloadThroughput: slow.download, uploadThroughput: slow.upload }] });
    expect(on[3]).toEqual({ method: "Emulation.setGeolocationOverride", params: { latitude: 1, longitude: 2, accuracy: 0 } });
    expect(on[6]).toEqual({ method: "Emulation.setDeviceMetricsOverride", params: { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { angle: 90, type: "landscapePrimary" } } });
    expect(on[7]?.params).toEqual({ enabled: true });
    expect(emulationCalls({ networkConditions: "Offline" })[0]?.params).toMatchObject({ offline: true });
  });

  test("Puppeteer's presets and the wait multipliers", () => {
    expect(PredefinedNetworkConditions["Slow 3G"]).toEqual({ download: 50000, upload: 50000, latency: 2000 });
    expect(PredefinedNetworkConditions["Slow 4G"]).toEqual(PredefinedNetworkConditions["Fast 3G"]);
    expect([networkMultiplier("Fast 4G"), networkMultiplier("Slow 4G"), networkMultiplier("Fast 3G"), networkMultiplier("Slow 3G"), networkMultiplier("Offline"), networkMultiplier(undefined)]).toEqual([1, 2.5, 5, 10, 1, 1]);
  });

  test("resize: whole positive CSS pixels", () => {
    expect(parseSize({ width: "1280", height: "800" })).toEqual({ width: 1280, height: 800 });
    for (const [w, h] of [["0", "1"], ["1.5", "1"], ["-1", "1"], ["x", "1"], [undefined, "1"]]) expect(usage(() => parseSize({ width: w, height: h }))).toBe("usage");
  });
});
