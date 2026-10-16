// tabcap site add | list | remove and tabcap plugin list | enable | disable:
// local files only (the store and the plugins directory), no daemon needed.
// The running daemon re-reads the store before every command, so a site added
// here is filled and scrubbed by it at once.

import { TabcapError } from "../shared/envelope.ts";
import type { Paths } from "../shared/paths.ts";
import { HOOK_PROTOCOL, listPlugins, pluginsDir, setEnabled } from "../daemon/hooks/plugins.ts";
import { Store, checkSiteName, type SiteListing } from "../daemon/store/db.ts";

function withStore<T>(p: Paths, fn: (s: Store) => T): T {
  const s = Store.open(p.config);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

function entryUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TabcapError("usage", `--url is not a URL: ${raw}`, "Pass the full entry URL, e.g. https://example.com/login.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new TabcapError("usage", `--url must be http(s): ${raw}`, "Pass the full entry URL, e.g. https://example.com/login.");
  return u;
}

/** Strip exactly one trailing newline (printf vs echo). */
export function stripNewline(s: string): string {
  return s.endsWith("\r\n") ? s.slice(0, -2) : s.endsWith("\n") ? s.slice(0, -1) : s;
}

/** Read a password from the terminal without echo. */
async function promptPassword(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new TabcapError("usage", "stdin is not a terminal, so there is no password prompt", "Pipe the password with --password-stdin (never pass it as an argument).");
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            resolve(buf);
            return;
          }
          if (ch === "\u0003" || ch === "\u0004") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            reject(new TabcapError("usage", "cancelled", "Run `tabcap site add` again."));
            return;
          }
          if (ch === "\u007f" || ch === "\b") buf = [...buf].slice(0, -1).join("");
          else buf += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

function listing(s: SiteListing): Record<string, unknown> {
  return {
    name: s.name,
    entryUrl: s.entryUrl,
    domains: s.domains,
    notes: s.notes,
    usernames: s.usernames,
    created: s.created,
    secrets: [`${s.name}.username`, `${s.name}.password`],
  };
}

export async function siteAdd(p: Paths, args: Record<string, unknown>, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<unknown> {
  const name = checkSiteName(typeof args["name"] === "string" ? args["name"] : "");
  const url = entryUrl(typeof args["url"] === "string" ? args["url"] : "");
  const user = typeof args["user"] === "string" ? args["user"] : "";
  if (user === "") throw new TabcapError("usage", "missing --user", "Pass --user <username>.");
  const domains =
    typeof args["domains"] === "string"
      ? args["domains"]
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d !== "")
      : [url.hostname];
  // Fail before asking for the password when the site exists already.
  withStore(p, (s) => {
    if (s.site(name) !== null) throw new TabcapError("conflict", `site "${name}" already exists`, `Run \`tabcap site remove ${name}\` first to replace it.`);
  });
  const password = args["passwordStdin"] === true ? stripNewline(await readStdin()) : await promptPassword(`Password for ${user} at ${name}: `);
  if (password === "") throw new TabcapError("usage", "empty password", "Type the password at the prompt, or pipe it with --password-stdin.");
  const notes = typeof args["notes"] === "string" ? args["notes"] : null;
  const path = withStore(p, (s) => {
    s.addSite({ name, entryUrl: url.href, domains, notes, username: user, password });
    return s.path;
  });
  return {
    site: name,
    entryUrl: url.href,
    domains,
    username: user,
    store: path,
    secrets: [`${name}.username`, `${name}.password`],
    warnings: [
      "the store is plaintext (0600, like ~/.netrc): prefer a test account",
      ...(password.length < 8 ? ["passwords shorter than 8 characters also replace unrelated text in tabcap output"] : []),
    ],
  };
}

export function siteList(p: Paths): unknown {
  return withStore(p, (s) => ({ store: s.path, sites: s.listSites().map(listing) }));
}

export function siteRemove(p: Paths, args: Record<string, unknown>): unknown {
  const name = checkSiteName(typeof args["name"] === "string" ? args["name"] : "");
  const removed = withStore(p, (s) => s.removeSite(name));
  if (!removed) throw new TabcapError("not-found", `no site named "${name}"`, "Run `tabcap site list`.");
  return { site: name, removed: true };
}

export function pluginList(p: Paths): unknown {
  return {
    dir: pluginsDir(p.config),
    protocol: HOOK_PROTOCOL,
    shipped: "none: tabcap ships the interface only; handlers are your own programs",
    plugins: listPlugins(p.config).map((x) => ({
      name: x.name,
      enabled: x.enabled,
      hooks: x.manifest?.hooks ?? [],
      version: x.manifest?.version ?? null,
      description: x.manifest?.description ?? null,
      command: x.manifest?.command ?? null,
      timeoutMs: x.manifest?.timeoutMs ?? null,
      error: x.error,
    })),
  };
}

export function pluginSet(p: Paths, args: Record<string, unknown>, on: boolean): unknown {
  const name = typeof args["name"] === "string" ? args["name"] : "";
  const x = setEnabled(p.config, name, on);
  return { name: x.name, enabled: x.enabled, hooks: x.manifest?.hooks ?? [] };
}
