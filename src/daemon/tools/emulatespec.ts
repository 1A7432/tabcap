/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2021 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure parts of `tabcap emulate` (unit tested); tools/emulate.ts sends them.
// Derived from:
// - chrome-devtools-mcp (commit e9000381f414bf5fd5fb83a9164fabfb8e0987b3, read
//   2026-10-15): src/tools/emulation.ts (the parameter set and its wording,
//   "each call replaces all emulation settings"), src/tools/ToolDefinition.ts
//   (viewportTransform, geolocationTransform), src/McpPage.ts (emulate: which
//   setting is cleared when left out), src/utils/WaitForHelper.ts
//   (getNetworkMultiplierFromString);
// - Puppeteer (commit 10c43c1b9101ab62835332393f49e3fb426dde88, read 2026-10-15):
//   packages/puppeteer-core/src/cdp/PredefinedNetworkConditions.ts (the presets)
//   and src/cdp/NetworkManager.ts (how a preset becomes CDP parameters).
// Modifications for tabcap (2026-10-15): CLI strings instead of zod schemas;
// errors are tabcap usage errors; only viewport, userAgent, colorScheme,
// networkConditions, cpuThrottlingRate and geolocation (no extra headers, no
// forced-colors / contrast / reduced-motion); a cleared geolocation uses
// Emulation.clearGeolocationOverride instead of setting 0,0.

import { TabcapError } from "../../shared/envelope.ts";
import { optNum, optStr, type Args } from "./args.ts";

export type Viewport = { width: number; height: number; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean; isLandscape: boolean };
export type Geolocation = { latitude: number; longitude: number };
export type NetworkPreset = "Offline" | "Slow 3G" | "Fast 3G" | "Slow 4G" | "Fast 4G";

/** Everything `emulate` sets on a tab; a field left out is not emulated. */
export type EmulationSettings = {
  viewport?: Viewport;
  userAgent?: string;
  colorScheme?: "dark" | "light";
  networkConditions?: NetworkPreset;
  cpuThrottlingRate?: number;
  geolocation?: Geolocation;
};

type NetworkConditions = { download: number; upload: number; latency: number };

export const PredefinedNetworkConditions: Readonly<Record<Exclude<NetworkPreset, "Offline">, NetworkConditions>> = Object.freeze({
  // Generally aligned with DevTools
  "Slow 3G": {
    // ~500Kbps down
    download: ((500 * 1000) / 8) * 0.8,
    // ~500Kbps up
    upload: ((500 * 1000) / 8) * 0.8,
    // 400ms RTT
    latency: 400 * 5,
  },
  "Fast 3G": {
    // ~1.6 Mbps down
    download: ((1.6 * 1000 * 1000) / 8) * 0.9,
    // ~0.75 Mbps up
    upload: ((750 * 1000) / 8) * 0.9,
    // 150ms RTT
    latency: 150 * 3.75,
  },
  // alias to Fast 3G to align with Lighthouse (crbug.com/342406608)
  // and DevTools (crbug.com/342406608),
  "Slow 4G": {
    // ~1.6 Mbps down
    download: ((1.6 * 1000 * 1000) / 8) * 0.9,
    // ~0.75 Mbps up
    upload: ((750 * 1000) / 8) * 0.9,
    // 150ms RTT
    latency: 150 * 3.75,
  },
  "Fast 4G": {
    // 9 Mbps down
    download: ((9 * 1000 * 1000) / 8) * 0.9,
    // 1.5 Mbps up
    upload: ((1.5 * 1000 * 1000) / 8) * 0.9,
    // 60ms RTT
    latency: 60 * 2.75,
  },
});

export const NETWORK_PRESETS: readonly NetworkPreset[] = ["Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G"];

const bad = (message: string, next: string) => new TabcapError("usage", message, next);

const VIEWPORT_FORMAT = "'<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]'";

/** `390x844x3,mobile,touch` → viewport (devicePixelRatio 1 and the tags false by default). */
export function viewportTransform(arg: string): Viewport {
  const [dimensions = "", ...tags] = arg.split(",").map((s) => s.trim());
  for (const t of tags) if (t !== "mobile" && t !== "touch" && t !== "landscape") throw bad(`unknown viewport tag "${t}"`, `Expected format ${VIEWPORT_FORMAT}.`);
  const parts = dimensions.split("x");
  if (parts.length < 2 || parts.length > 3) throw bad(`invalid viewport "${arg}"`, `Expected format ${VIEWPORT_FORMAT}, e.g. 1280x800 or 390x844x3,mobile,touch.`);
  const [width, height, dpr] = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (width === undefined || !Number.isFinite(width) || width <= 0 || !Number.isInteger(width)) {
    throw bad(`Invalid viewport width "${parts[0] ?? ""}".`, `Expected format ${VIEWPORT_FORMAT} with a positive whole width.`);
  }
  if (height === undefined || !Number.isFinite(height) || height <= 0 || !Number.isInteger(height)) {
    throw bad(`Invalid viewport height "${parts[1] ?? ""}".`, `Expected format ${VIEWPORT_FORMAT} with a positive whole height.`);
  }
  if (dpr !== undefined && (!Number.isFinite(dpr) || dpr <= 0)) throw bad(`Invalid devicePixelRatio "${parts[2] ?? ""}".`, "Expected a positive number.");
  if (width > 10_000_000 || height > 10_000_000) throw bad("viewport too large", "Width and height must be at most 10000000 (CDP limit).");
  return { width, height, deviceScaleFactor: dpr ?? 1, isMobile: tags.includes("mobile"), hasTouch: tags.includes("touch"), isLandscape: tags.includes("landscape") };
}

/** `52.52,13.40` → latitude / longitude, range checked. */
export function geolocationTransform(arg: string): Geolocation {
  const parts = arg.split(",");
  if (parts.length !== 2) throw bad(`invalid geolocation "${arg}"`, "Expected `<latitude>,<longitude>`, e.g. 52.52,13.40.");
  const [latitude, longitude] = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (latitude === undefined || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw bad(`Invalid latitude "${parts[0] ?? ""}".`, "Latitude must be a number between -90 and 90.");
  if (longitude === undefined || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw bad(`Invalid longitude "${parts[1] ?? ""}".`, "Longitude must be a number between -180 and 180.");
  return { latitude, longitude };
}

/**
 * The daemon arguments of one `emulate` call → the complete new settings.
 * Each call replaces all earlier settings: whatever is not given here ends up
 * cleared (an empty user agent and `--color-scheme auto` clear explicitly).
 */
export function parseEmulate(a: Args): EmulationSettings {
  const out: EmulationSettings = {};
  const viewport = optStr(a, "viewport");
  if (viewport !== null && viewport !== "") out.viewport = viewportTransform(viewport);
  const ua = optStr(a, "userAgent");
  if (ua !== null && ua !== "") out.userAgent = ua;
  const scheme = optStr(a, "colorScheme");
  if (scheme !== null && scheme !== "auto" && scheme !== "") {
    if (scheme !== "dark" && scheme !== "light") throw bad(`--color-scheme ${scheme}?`, "Use --color-scheme dark | light | auto.");
    out.colorScheme = scheme;
  }
  const net = optStr(a, "networkConditions");
  if (net !== null && net !== "") {
    const preset = NETWORK_PRESETS.find((p) => p.toLowerCase() === net.toLowerCase());
    if (preset === undefined) throw bad(`--network-conditions ${net}?`, `Use one of: ${NETWORK_PRESETS.map((p) => JSON.stringify(p)).join(", ")}.`);
    out.networkConditions = preset;
  }
  const rate = optNum(a, "cpuThrottlingRate");
  if (rate !== null) {
    if (rate < 1 || rate > 20) throw bad("--cpu-throttling-rate must be between 1 and 20", "1 means no throttling, e.g. --cpu-throttling-rate 4.");
    if (rate !== 1) out.cpuThrottlingRate = rate;
  }
  const geo = optStr(a, "geolocation");
  if (geo !== null && geo !== "") out.geolocation = geolocationTransform(geo);
  return out;
}

export type CdpCall = { method: string; params: Record<string, unknown> };

/** The CDP calls that make a tab's emulation equal to `s` (every setting sent, so earlier ones are replaced). */
export function emulationCalls(s: EmulationSettings): CdpCall[] {
  const calls: CdpCall[] = [];
  // NetworkManager#applyNetworkConditions: state for navigator.onLine / connection, then the shaping rule.
  const preset = s.networkConditions;
  const net =
    preset === undefined
      ? { offline: false, latency: 0, upload: -1, download: -1 }
      : preset === "Offline"
        ? { offline: true, latency: 0, upload: 0, download: 0 }
        : { offline: false, ...PredefinedNetworkConditions[preset] };
  calls.push({ method: "Network.overrideNetworkState", params: { offline: net.offline, latency: net.latency, uploadThroughput: net.upload, downloadThroughput: net.download } });
  calls.push({
    method: "Network.emulateNetworkConditionsByRule",
    params: { matchedNetworkConditions: [{ urlPattern: "", offline: net.offline, latency: net.latency, downloadThroughput: net.download, uploadThroughput: net.upload }] },
  });
  calls.push({ method: "Emulation.setCPUThrottlingRate", params: { rate: s.cpuThrottlingRate ?? 1 } });
  calls.push(
    s.geolocation === undefined
      ? { method: "Emulation.clearGeolocationOverride", params: {} }
      : { method: "Emulation.setGeolocationOverride", params: { latitude: s.geolocation.latitude, longitude: s.geolocation.longitude, accuracy: 0 } },
  );
  calls.push({ method: "Emulation.setUserAgentOverride", params: { userAgent: s.userAgent ?? "" } });
  calls.push({ method: "Emulation.setEmulatedMedia", params: { features: [{ name: "prefers-color-scheme", value: s.colorScheme ?? "" }] } });
  const v = s.viewport;
  if (v === undefined) {
    calls.push({ method: "Emulation.clearDeviceMetricsOverride", params: {} });
    calls.push({ method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } });
  } else {
    calls.push({
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: v.width,
        height: v.height,
        deviceScaleFactor: v.deviceScaleFactor,
        mobile: v.isMobile,
        screenOrientation: v.isLandscape ? { angle: 90, type: "landscapePrimary" } : { angle: 0, type: "portraitPrimary" },
      },
    });
    calls.push({ method: "Emulation.setTouchEmulationEnabled", params: { enabled: v.hasTouch } });
  }
  return calls;
}

/** WaitForHelper getNetworkMultiplierFromString: how much longer navigations may take under a preset. */
export function networkMultiplier(preset: NetworkPreset | undefined): number {
  switch (preset) {
    case "Fast 4G":
      return 1;
    case "Slow 4G":
      return 2.5;
    case "Fast 3G":
      return 5;
    case "Slow 3G":
      return 10;
  }
  return 1;
}
