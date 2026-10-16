// tabcap proxy add | list | remove | check | set-state and tabcap account
// add | remove | bind | list | set-state (0.4-D, docs/08 §3 0.4): the store only, no daemon needed. The
// running daemon re-reads the store before every command, so a proxy added
// here is scrubbed from its output at once. Passwords come from stdin or the
// prompt, never from argv, and no output carries one.

import { readPoolConfig } from "../shared/config.ts";
import { TabcapError } from "../shared/envelope.ts";
import type { Paths } from "../shared/paths.ts";
import { Secrets } from "../daemon/secrets.ts";
import { checkProxyName, checkSiteName, hostPort, PROXY_KEYWORDS, type ProxyRow, type Store } from "../daemon/store/db.ts";
import { accountCleared, accountState, proxyReactivated, proxyUnchecked } from "../daemon/pool/rules.ts";
import { checkThrough, parseProxyUrl, patchFor, type HttpClient } from "../daemon/pool/proxy.ts";
import { isRecord, str } from "../shared/json.ts";
import { send } from "./client.ts";
import { promptPassword, stripNewline, withStore } from "./site.ts";

const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** `<site>.<user>`: the site name has no dots, so the first dot separates them (usernames may hold dots). */
export function parseAccountRef(ref: string): { site: string; user: string } {
  const i = ref.indexOf(".");
  if (i <= 0 || i === ref.length - 1) throw new TabcapError("usage", `bad account reference: ${JSON.stringify(ref)}`, "Use <site>.<user>, e.g. example.alice (see `tabcap account list`).");
  return { site: checkSiteName(ref.slice(0, i)), user: ref.slice(i + 1) };
}

function proxyListing(p: ProxyRow): Record<string, unknown> {
  return {
    name: p.name,
    scheme: p.scheme,
    hostPort: hostPort(p),
    user: p.username,
    hasAuth: p.password !== null && p.password !== "",
    bypass: p.bypass,
    state: p.state,
    lastCheck: p.lastCheckAt,
    lastOk: p.lastOkAt,
    latencyMs: p.latencyMs,
    failCount: p.failCount,
    recheckAt: p.recheckAt,
  };
}

export async function proxyAdd(p: Paths, args: Record<string, unknown>, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<unknown> {
  const name = checkProxyName(s(args["name"]) ?? "");
  const url = parseProxyUrl(s(args["url"]) ?? "");
  const user = s(args["user"]);
  const stdin = args["passwordStdin"] === true;
  if (stdin && user === null) throw new TabcapError("usage", "--password-stdin needs --user", "Pass --user <name> with the password on stdin.");
  // docs/07 spike Q7: Chrome 155 offers SOCKS5 no-auth only; SOCKS4 has no password at all.
  if (user !== null && (url.scheme === "socks5" || url.scheme === "socks4")) {
    throw new TabcapError("unsupported", `${url.scheme} with a username is not supported: Chrome only offers no-auth SOCKS`, "Add the SOCKS proxy without --user, or run a local no-auth forwarder in front of the authenticated one.");
  }
  // Fail before asking for the password when the name is taken.
  withStore(p, (st) => {
    if (st.proxy(name) !== null) throw new TabcapError("conflict", `proxy "${name}" already exists`, `Run \`tabcap proxy remove ${name}\` first to replace it.`);
  });
  let password: string | null = null;
  if (user !== null) {
    password = stdin ? stripNewline(await readStdin()) : await promptPassword(`Password for ${user} at proxy ${name}: `);
    if (password === "") throw new TabcapError("usage", "empty password", "Type the password at the prompt, or pipe it with --password-stdin.");
  }
  const bypass = s(args["bypass"]);
  const row = withStore(p, (st) => {
    st.addProxy({ name, scheme: url.scheme, host: url.host, port: url.port, username: user, password, bypass });
    return st.proxy(name);
  });
  const warnings = ["the store is plaintext (0600, like ~/.netrc)"];
  if (url.scheme === "socks5" || url.scheme === "socks4") warnings.push("SOCKS without authentication is passed to Chrome as is; it is not covered by tests (待验)");
  if (password !== null && password.length < 8) warnings.push("passwords shorter than 8 characters also replace unrelated text in tabcap output");
  return { proxy: row === null ? { name } : proxyListing(row), secret: password === null ? null : `proxy.${name}`, warnings };
}

export function proxyList(p: Paths): unknown {
  return withStore(p, (st) => ({ store: st.path, proxies: st.proxies().map(proxyListing) }));
}

export function proxyRemove(p: Paths, args: Record<string, unknown>): unknown {
  const name = s(args["name"]) ?? "";
  const removed = withStore(p, (st) => st.removeProxy(name));
  if (!removed) throw new TabcapError("not-found", `no proxy named "${name}"`, "Run `tabcap proxy list`.");
  return { proxy: name, removed: true };
}

/** Errors of a check may echo the credentialed proxy URL: replace every known secret. */
function scrubber(st: Store): (x: string) => string {
  const sec = new Secrets();
  sec.setStored(st.knownSecrets());
  return (x) => sec.scrub(x);
}

export async function proxyCheck(p: Paths, args: Record<string, unknown>, o: { fetch?: HttpClient; now?: () => number } = {}): Promise<unknown> {
  const name = s(args["name"]) ?? "";
  const now = o.now ?? Date.now;
  const url = s(args["url"]) ?? readPoolConfig(p.configFile).health.url;
  if (url !== null && !/^https?:\/\/\S+$/i.test(url)) throw new TabcapError("usage", "--url must be an http(s) URL", "e.g. --url http://127.0.0.1:8080/echo");
  const st0 = withStore(p, (st) => st.proxy(name));
  if (st0 === null) throw new TabcapError("not-found", `no proxy named "${name}"`, "Run `tabcap proxy list`.");
  if (url === null) {
    // Owner rule 10-16: without a health URL nothing is contacted.
    const row = withStore(p, (st) => {
      st.updateProxy(name, proxyUnchecked(st0));
      return st.proxy(name);
    });
    return { proxy: name, contacted: false, url: null, state: row?.state ?? st0.state, note: "no --url and no pool.health.url in config.json: nothing was contacted" };
  }
  const r = await checkThrough(st0, url, o.fetch);
  return withStore(p, (st) => {
    const cur = st.proxy(name) ?? st0;
    st.updateProxy(name, patchFor(cur, r, now()));
    const row = st.proxy(name) ?? cur;
    const scrub = scrubber(st);
    if (r === null) return { proxy: name, contacted: false, url, state: row.state, note: `${row.scheme} proxies cannot be checked (no SOCKS in the HTTP client); state unchanged` };
    return { proxy: name, contacted: true, url, ok: r.ok, status: r.status, latencyMs: r.latencyMs, error: r.error === null ? null : scrub(r.error), state: row.state, failCount: row.failCount, recheckAt: row.recheckAt };
  });
}

export function accountBind(p: Paths, args: Record<string, unknown>): unknown {
  const { site, user } = parseAccountRef(s(args["account"]) ?? "");
  const proxy = s(args["proxy"]);
  if (proxy === null) throw new TabcapError("usage", "missing --proxy", "Pass --proxy <name>|system|none.");
  if (!PROXY_KEYWORDS.includes(proxy)) checkProxyName(proxy);
  withStore(p, (st) => st.bindAccount(site, user, proxy));
  return { account: `${site}.${user}`, site, user, proxy };
}

export function accountList(p: Paths, args: Record<string, unknown>, now: () => number = Date.now): unknown {
  const site = s(args["site"]);
  return withStore(p, (st) => {
    if (site !== null && st.site(checkSiteName(site)) === null) throw new TabcapError("not-found", `no site named "${site}"`, "Run `tabcap site list`.");
    const t = now();
    return {
      accounts: st.accounts(site ?? undefined).map((a) => {
        const state = accountState(a, t);
        return { account: `${a.site}.${a.username}`, site: a.site, user: a.username, state, coolUntil: state === "cooling" ? a.coolUntil : null, proxy: a.proxy, lastUsedAt: a.lastUsedAt };
      }),
    };
  });
}

export function accountSetState(p: Paths, args: Record<string, unknown>): unknown {
  const { site, user } = parseAccountRef(s(args["account"]) ?? "");
  const state = s(args["state"]);
  if (state !== "active" && state !== "disabled") throw new TabcapError("usage", "state must be active or disabled", "tabcap account set-state <site>.<user> active|disabled");
  return withStore(p, (st) => {
    const a = st.account(site, user);
    if (a === null) throw new TabcapError("not-found", `no account ${site}.${user}`, "Run `tabcap account list`.");
    st.patchAccount(site, user, state === "active" ? accountCleared() : { state: "disabled", coolUntil: null });
    return { account: `${site}.${user}`, from: a.state, state };
  });
}

/** Names of the live sessions bound to a site account, from the running daemon (none when it is not running). */
export async function liveAccountSessions(p: Paths, site: string, user: string): Promise<string[]> {
  const env = await send(p, "session.list", {}, "default", [], 5000);
  if (!env.ok || !isRecord(env.data) || !Array.isArray(env.data["sessions"])) return [];
  const out: string[] = [];
  for (const x of env.data["sessions"]) {
    if (isRecord(x) && str(x, "site") === site && str(x, "account") === user) out.push(str(x, "session") ?? "?");
  }
  return out;
}

/**
 * `account add <site> --user <u> [--password-stdin] [--totp-stdin]`: another
 * account for a stored site. With --totp-stdin (which needs --password-stdin)
 * stdin carries two lines: the password, then the TOTP seed. Neither is
 * ever part of the output.
 */
export async function accountAdd(p: Paths, args: Record<string, unknown>, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<unknown> {
  const site = checkSiteName(s(args["site"]) ?? "");
  const user = s(args["user"]);
  if (user === null) throw new TabcapError("usage", "missing --user", "Pass --user <username>.");
  const stdin = args["passwordStdin"] === true;
  const totp = args["totpStdin"] === true;
  if (totp && !stdin) throw new TabcapError("usage", "--totp-stdin needs --password-stdin", "Pipe two lines on stdin: the password, then the TOTP seed.");
  // Fail before asking for the password when the site is unknown or the account exists.
  withStore(p, (st) => {
    if (st.site(site) === null) throw new TabcapError("not-found", `no site named "${site}"`, "Run `tabcap site list`, or add it with `tabcap site add`.");
    if (st.account(site, user) !== null) throw new TabcapError("conflict", `account ${site}.${user} already exists`, "Use another --user, or `tabcap account remove` the old one first.");
  });
  let password: string;
  let seed: string | null = null;
  if (stdin) {
    const raw = await readStdin();
    if (totp) {
      const lines = raw.split(/\r?\n/);
      password = lines[0] ?? "";
      seed = (lines[1] ?? "").trim();
      if (seed === "") throw new TabcapError("usage", "empty TOTP seed", "Pipe the password on line 1 and the TOTP seed on line 2.");
    } else password = stripNewline(raw);
  } else password = await promptPassword(`Password for ${user} at ${site}: `);
  if (password === "") throw new TabcapError("usage", "empty password", "Type the password at the prompt, or pipe it with --password-stdin.");
  withStore(p, (st) => st.addAccount({ site, username: user, password, totpSeed: seed }));
  const warnings = ["the store is plaintext (0600, like ~/.netrc): prefer a test account"];
  if (password.length < 8) warnings.push("passwords shorter than 8 characters also replace unrelated text in tabcap output");
  return { account: `${site}.${user}`, site, user, state: "active", proxy: null, secrets: [`${site}.password`], warnings };
}

export async function accountRemove(p: Paths, args: Record<string, unknown>, live: (site: string, user: string) => Promise<string[]> = (a, b) => liveAccountSessions(p, a, b)): Promise<unknown> {
  const { site, user } = parseAccountRef(s(args["account"]) ?? "");
  const exists = withStore(p, (st) => st.account(site, user) !== null);
  if (!exists) throw new TabcapError("not-found", `no account ${site}.${user}`, "Run `tabcap account list`.");
  const using = await live(site, user);
  if (using.length > 0) throw new TabcapError("conflict", `account ${site}.${user} is in use by session ${using.map((x) => `"${x}"`).join(", ")}`, `Run \`tabcap session stop ${using[0] ?? "<name>"}\` first.`);
  withStore(p, (st) => st.removeAccount(site, user));
  return { account: `${site}.${user}`, removed: true };
}

export function proxySetState(p: Paths, args: Record<string, unknown>): unknown {
  const name = s(args["name"]) ?? "";
  const state = s(args["state"]);
  if (state !== "active" && state !== "disabled") throw new TabcapError("usage", "state must be active or disabled", "tabcap proxy set-state <name> active|disabled");
  return withStore(p, (st) => {
    const row = st.proxy(name);
    if (row === null) throw new TabcapError("not-found", `no proxy named "${name}"`, "Run `tabcap proxy list`.");
    // active = back to the pre-check state: `unknown` / `unchecked` until the next check says otherwise.
    st.updateProxy(name, state === "disabled" ? { state: "disabled" } : proxyReactivated());
    return { proxy: name, from: row.state, state: st.proxy(name)?.state ?? state };
  });
}
