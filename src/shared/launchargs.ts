// Chrome launch arguments as tabcap writes them into a bundle manifest
// (`producer.browser.args` / `extraArgs` / `dropArgs`, docs/04 §42) and hashes
// them for the wire baseline cache (docs/07 §6). Machine-specific parts are
// replaced, everything else stays as launched (review 10-21, owner decision):
//   - --user-data-dir=<profile>;
//   - --load-extension item by item: tabcap's own extension <extension>, the
//     user's items like any other value;
//   - any other `--name=value`: a URL's user:pass@ is removed, and a path that
//     starts with the home directory (at the start of the value, after `=`, a
//     list separator or file://) becomes <home> with the rest of the path kept.
// tabcap's own command line normalizes exactly as in 0.8.1 (only the profile
// and its extension were machine-specific), so cached wire profiles stay valid.

import { homedir } from "node:os";

export type LaunchArgsContext = {
  /** The user's home directory; null, "" or a root ("/", "C:\") replaces nothing. */
  home: string | null;
  /** tabcap's own extension directory, the `--load-extension` item that reads <extension>. */
  extensionDir: string | null;
};

/** The running host's context. */
export function hostLaunchContext(extensionDir: string | null): LaunchArgsContext {
  return { home: homedir(), extensionDir };
}

/** `scheme://user[:pass]@`: greedy up to the authority's last `@`, within one list item. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s,;]*@/gi;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function homePattern(home: string | null): RegExp | null {
  if (home === null) return null;
  const h = home.replace(/[\\/]+$/, "");
  // "" (was "/" or empty) and drive roots ("C:") would match nearly every path.
  if (h === "" || /^[A-Za-z]:$/.test(h)) return null;
  return new RegExp(`(^|[=,;\\s"']|file://)${escapeRegExp(h)}(?=[\\\\/,;\\s"']|$)`, "g");
}

/** One switch value: URL credentials removed, the home prefix of paths replaced. */
function cleanValue(v: string, home: RegExp | null): string {
  const out = v.replace(URL_USERINFO, "$1");
  return home === null ? out : out.replace(home, "$1<home>");
}

/**
 * Pure: the command line as `browser start` / `browser status` answer it (review 10-21): only a URL
 * value's userinfo is removed from each `--name=value`; paths stay (an answer is not evidence).
 */
export function withoutUrlCredentials(args: readonly string[]): string[] {
  return args.map((a) => {
    const eq = a.indexOf("=");
    return !a.startsWith("--") || eq < 0 ? a : `${a.slice(0, eq)}=${cleanValue(a.slice(eq + 1), null)}`;
  });
}

/** Pure: `args` with the machine-specific parts replaced, in launch order (what the manifest records and the wire hash covers). */
export function normalizedLaunchArgs(args: readonly string[], ctx: LaunchArgsContext): string[] {
  const home = homePattern(ctx.home);
  return args.map((a) => {
    const eq = a.indexOf("=");
    if (!a.startsWith("--") || eq < 0) return a;
    const name = a.slice(0, eq);
    const value = a.slice(eq + 1);
    if (name === "--user-data-dir") return "--user-data-dir=<profile>";
    if (name === "--load-extension") return `${name}=${value.split(",").map((x) => (ctx.extensionDir !== null && x === ctx.extensionDir ? "<extension>" : cleanValue(x, home))).join(",")}`;
    return `${name}=${cleanValue(value, home)}`;
  });
}
