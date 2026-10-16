//! Corpus profile assembler (spec/profile-schema.md).
//! Input: N `wireprint report` outputs (per-connection reports) for one (browser, version, os, arch) configuration.
//! Output: one profile JSON with hashes AND raw lists, per-sample extension orders, and stability flags.
//! Fields that cannot be captured are written as null (never omitted) so `wireprint diff` can tell
//! "not captured" from "absent". Header values are copied only from the allow-listed set the report carries.
const std = @import("std");
const Value = std.json.Value;
const Json = std.json.Stringify;

pub const Meta = struct {
    kind: []const u8 = "browser", // browser | library | tool
    name: []const u8,
    version: []const u8,
    channel: ?[]const u8 = null,
    claims: ?[]const u8 = null,
    os: []const u8,
    os_version: ?[]const u8 = null,
    arch: []const u8,
    headless: bool = false,
    captured_at: ?[]const u8 = null,
    method: []const u8 = "manual",
    server: []const u8 = "wireprint-report 0.1.0",
    server_host_os: []const u8 = "unknown",
    raw_dir: ?[]const u8 = null,
    notes: []const u8 = "",
};

pub const Error = error{ EmptyInput, NotAReport } || std.mem.Allocator.Error || std.Io.Writer.Error;

fn get(v: Value, path: []const []const u8) ?Value {
    var cur = v;
    for (path) |k| {
        if (cur != .object) return null;
        cur = cur.object.get(k) orelse return null;
    }
    return cur;
}

fn getStr(v: Value, path: []const []const u8) ?[]const u8 {
    const x = get(v, path) orelse return null;
    return if (x == .string) x.string else null;
}

fn getBool(v: Value, path: []const []const u8) ?bool {
    const x = get(v, path) orelse return null;
    return if (x == .bool) x.bool else null;
}

fn getInt(v: Value, path: []const []const u8) ?i64 {
    const x = get(v, path) orelse return null;
    return if (x == .integer) x.integer else null;
}

fn writeOpt(js: *Json, v: ?Value) !void {
    if (v) |x| try js.write(x) else try js.write(null);
}

fn headerValue(report: Value, name: []const u8) ?[]const u8 {
    const headers = get(report, &.{ "http", "headers" }) orelse return null;
    if (headers != .array) return null;
    for (headers.array.items) |h| {
        const n = getStr(h, &.{"name"}) orelse continue;
        if (std.ascii.eqlIgnoreCase(n, name)) return getStr(h, &.{"value"});
    }
    return null;
}

fn stringArrayEql(a: Value, b: Value) bool {
    if (a != .array or b != .array or a.array.items.len != b.array.items.len) return false;
    for (a.array.items, b.array.items) |x, y| {
        if (x != .string or y != .string or !std.mem.eql(u8, x.string, y.string)) return false;
    }
    return true;
}

/// GREASE values (RFC 8701, ?a?a) are drawn fresh per connection, so two ClientHellos with the same
/// real extension order still differ in their raw `extensions_order`. 0029 (pre_shared_key) only
/// appears on resumption. Both are dropped before judging order stability.
fn isVolatileExt(hex: []const u8) bool {
    if (hex.len != 4) return false;
    if (hex[0] == hex[2] and hex[1] == hex[3] and hex[1] == 'a') return true; // GREASE
    return std.mem.eql(u8, hex, "0029");
}

/// `extensions_order` with volatile entries removed (see `isVolatileExt`). Caller frees.
fn stableOrder(gpa: std.mem.Allocator, order: Value) std.mem.Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    errdefer out.deinit(gpa);
    if (order == .array) for (order.array.items) |x| {
        if (x == .string and !isVolatileExt(x.string)) try out.append(gpa, x.string);
    };
    return out.toOwnedSlice(gpa);
}

fn sliceEql(a: []const []const u8, b: []const []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (!std.mem.eql(u8, x, y)) return false;
    return true;
}

/// Writes the profile for `reports` (parsed report JSONs, first one is the reference sample).
pub fn assemble(gpa: std.mem.Allocator, js: *Json, reports: []const Value, meta: Meta) Error!void {
    if (reports.len == 0) return error.EmptyInput;
    const r0 = reports[0];
    if (get(r0, &.{ "tls", "client_hello" }) == null) return error.NotAReport;

    var major_buf: [16]u8 = undefined;
    const major = blk: {
        const dot = std.mem.indexOfScalar(u8, meta.version, '.') orelse meta.version.len;
        break :blk std.fmt.bufPrint(&major_buf, "{s}", .{meta.version[0..dot]}) catch meta.version;
    };
    const id = try std.fmt.allocPrint(gpa, "{s}/{s}/{s}-{s}/{s}", .{ meta.name, major, meta.os, meta.arch, meta.version });
    defer gpa.free(id);

    try js.beginObject();
    try js.objectField("schema_version");
    try js.write(1);
    try js.objectField("id");
    try js.write(id);

    try js.objectField("subject");
    try js.beginObject();
    try js.objectField("kind");
    try js.write(meta.kind);
    try js.objectField("name");
    try js.write(meta.name);
    try js.objectField("version");
    try js.write(meta.version);
    try js.objectField("channel");
    try js.write(meta.channel);
    try js.objectField("claims");
    try js.write(meta.claims);
    try js.endObject();

    try js.objectField("platform");
    try js.beginObject();
    try js.objectField("os");
    try js.write(meta.os);
    try js.objectField("os_version");
    try js.write(meta.os_version);
    try js.objectField("arch");
    try js.write(meta.arch);
    try js.objectField("headless");
    try js.write(meta.headless);
    try js.endObject();

    // Which samples are first connections vs. resumptions (pre_shared_key present). The reference sample
    // is the first non-PSK *navigation* request (sec-fetch-mode: navigate) when there is one: browsers use
    // a different header set/order for sub-resources (referer, sec-fetch-dest: image, ...).
    var first_idx: ?usize = null;
    var nav_idx: ?usize = null;
    var resumed_idx: ?usize = null;
    for (reports, 0..) |r, i| {
        const psk = getBool(r, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false;
        if (psk and resumed_idx == null) resumed_idx = i;
        if (!psk and first_idx == null) first_idx = i;
        if (!psk and nav_idx == null) {
            if (headerValue(r, "sec-fetch-mode")) |m| if (std.mem.eql(u8, m, "navigate")) {
                nav_idx = i;
            };
        }
    }
    const ref = reports[nav_idx orelse first_idx orelse 0];

    try js.objectField("capture");
    try js.beginObject();
    try js.objectField("captured_at");
    try js.write(meta.captured_at);
    try js.objectField("method");
    try js.write(meta.method);
    try js.objectField("server");
    try js.write(meta.server);
    try js.objectField("server_host_os");
    try js.write(meta.server_host_os);
    try js.objectField("connection");
    try js.write(if (first_idx != null) "first" else "resumed");
    try js.objectField("samples");
    try js.write(reports.len);
    try js.objectField("raw_dir");
    try js.write(meta.raw_dir);
    try js.endObject();

    // ---- tls ----
    try js.objectField("tls");
    try js.beginObject();
    {
        // ja3: string/hash of the reference; stable if every first-connection sample has the same hash.
        try js.objectField("ja3");
        try js.beginObject();
        try js.objectField("string");
        try js.write(getStr(ref, &.{ "tls", "ja3", "string" }));
        try js.objectField("hash");
        try js.write(getStr(ref, &.{ "tls", "ja3", "hash" }));
        try js.objectField("stable_across_samples");
        try js.write(allSameString(reports, &.{ "tls", "ja3", "hash" }, true));
        try js.endObject();

        try js.objectField("ja4");
        try js.beginObject();
        try js.objectField("ja4");
        try js.write(getStr(ref, &.{ "tls", "ja4", "ja4" }));
        try js.objectField("ja4_r");
        try js.write(getStr(ref, &.{ "tls", "ja4", "ja4_r" }));
        try js.objectField("ja4_o");
        try js.write(getStr(ref, &.{ "tls", "ja4", "ja4_o" }));
        try js.objectField("ja4_ro");
        try js.write(getStr(ref, &.{ "tls", "ja4", "ja4_ro" }));
        try js.objectField("stable_across_samples");
        try js.write(allSameString(reports, &.{ "tls", "ja4", "ja4" }, true));
        try js.endObject();

        try js.objectField("handshake");
        try js.beginObject();
        try js.objectField("version");
        try js.write(getStr(ref, &.{ "tls", "handshake", "version" }));
        try js.objectField("cipher_negotiated");
        try js.write(getStr(ref, &.{ "tls", "handshake", "cipher" }));
        try js.objectField("alpn_negotiated");
        try js.write(getStr(ref, &.{ "tls", "handshake", "alpn" }));
        try js.endObject();

        const ch = get(ref, &.{ "tls", "client_hello" }) orelse .null;
        try js.objectField("client_hello");
        try js.beginObject();
        try js.objectField("legacy_version");
        try writeOpt(js, get(ch, &.{"legacy_version"}));
        try js.objectField("session_id_length");
        try writeOpt(js, get(ch, &.{"session_id_length"}));
        try js.objectField("cipher_suites");
        try writeOpt(js, get(ch, &.{"cipher_suites"}));
        try js.objectField("cipher_grease_positions");
        try writeOpt(js, get(ch, &.{"cipher_grease_positions"}));
        try js.objectField("compression_methods");
        try writeOpt(js, get(ch, &.{"compression_methods"}));

        // Extension orders of every first-connection sample; sorted list from the reference.
        try js.objectField("extensions_order_samples");
        try js.beginArray();
        var randomized = false;
        // How many orders the judgement saw: with fewer than two, "fixed" cannot be told from "random".
        var order_samples: usize = 0;
        const ref_order = get(ch, &.{"extensions_order"});
        // Samples are written raw (GREASE included: that is what the wire carried), but stability is judged on
        // the GREASE/PSK-free order: Safari 26 keeps a fixed order while its two GREASE values change every
        // connection, Chrome really permutes.
        const ref_stable: ?[]const []const u8 = if (ref_order) |ro| try stableOrder(gpa, ro) else null;
        defer if (ref_stable) |rs| gpa.free(rs);
        // When every sample carries pre_shared_key (browser had a ticket from an earlier run) fall back to all
        // samples so extension-order stability can still be judged; capture.connection says "resumed".
        const use_all = first_idx == null;
        for (reports) |r| {
            const psk = getBool(r, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false;
            if (psk and !use_all) continue;
            const order = get(r, &.{ "tls", "client_hello", "extensions_order" }) orelse continue;
            try js.write(order);
            order_samples += 1;
            if (ref_stable) |rs| {
                const so = try stableOrder(gpa, order);
                defer gpa.free(so);
                if (!sliceEql(rs, so)) randomized = true;
            }
        }
        try js.endArray();
        // Sorted set of the reference sample without GREASE (schema: GREASE goes to extension_grease_positions).
        try js.objectField("extensions_sorted");
        if (ref_stable) |rs| {
            const sorted = try gpa.dupe([]const u8, rs);
            defer gpa.free(sorted);
            std.mem.sort([]const u8, sorted, {}, strLess);
            try js.write(sorted);
        } else try js.write(null);
        try js.objectField("extension_count");
        try writeOpt(js, get(ch, &.{"extension_count"}));
        // extension_order: "randomized" | "fixed" | "unknown" (fewer than two samples were judged);
        // extension_order_randomized keeps the boolean for older readers and is null when unknown.
        const known = order_samples >= 2;
        try js.objectField("extension_order");
        try js.write(if (!known) "unknown" else if (randomized) "randomized" else "fixed");
        try js.objectField("extension_order_samples_judged");
        try js.write(order_samples);
        try js.objectField("extension_order_randomized");
        if (known) try js.write(randomized) else try js.write(null);
        try js.objectField("extension_grease_positions");
        try writeOpt(js, get(ch, &.{"extension_grease_positions"}));
        try js.objectField("supported_versions");
        try writeOpt(js, get(ch, &.{"supported_versions"}));
        try js.objectField("supported_groups");
        try writeOpt(js, get(ch, &.{"supported_groups"}));
        try js.objectField("key_share_groups");
        try writeOpt(js, get(ch, &.{"key_share_groups"}));
        try js.objectField("key_shares");
        try writeOpt(js, get(ch, &.{"key_shares"}));
        try js.objectField("signature_algorithms");
        try writeOpt(js, get(ch, &.{"signature_algorithms"}));
        try js.objectField("ec_point_formats");
        try writeOpt(js, get(ch, &.{"ec_point_formats"}));
        try js.objectField("alpn");
        try writeOpt(js, get(ch, &.{"alpn"}));
        try js.objectField("sni_present");
        try js.write(getStr(ch, &.{"server_name"}) != null);
        try js.objectField("psk_present");
        try js.write(getBool(ch, &.{"has_pre_shared_key"}) orelse false);
        try js.objectField("ech_present");
        try js.write(getBool(ch, &.{"has_encrypted_client_hello"}) orelse false);
        try js.objectField("ech_kind");
        try js.write(if (getBool(ch, &.{"has_encrypted_client_hello"}) orelse false) @as(?[]const u8, "grease-or-real") else null);
        try js.objectField("trust_anchors_present");
        try js.write(getBool(ch, &.{"has_trust_anchors"}) orelse false);
        try js.objectField("alps_codepoint");
        try js.write(alpsCodepoint(ch));
        try js.objectField("total_length");
        try writeOpt(js, get(ch, &.{"message_length"}));
        try js.objectField("tcp_segments");
        try js.write(null);
        try js.endObject();
    }
    try js.endObject();

    // ---- http2 ----
    try js.objectField("http2");
    try js.beginObject();
    {
        const h2 = get(ref, &.{"http2"}) orelse .null;
        try js.objectField("akamai");
        try writeOpt(js, get(h2, &.{"akamai"}));
        try js.objectField("settings");
        try writeOpt(js, get(h2, &.{"settings"}));
        try js.objectField("window_update");
        try writeOpt(js, get(h2, &.{"window_update"}));
        try js.objectField("priority_frames");
        try writeOpt(js, get(h2, &.{"priority_frames"}));
        try js.objectField("pseudo_header_order");
        try writeOpt(js, get(h2, &.{"pseudo_header_order"}));
        try js.objectField("sends_priority_header");
        try js.write(headerValue(ref, "priority") != null);
        try js.objectField("no_rfc7540_priorities");
        try js.write(settingValue(h2, 9));
        try js.objectField("stable_across_samples");
        try js.write(allSameString(reports, &.{ "http2", "akamai" }, false));
    }
    try js.endObject();

    // ---- http ----
    try js.objectField("http");
    try js.beginObject();
    {
        try js.objectField("method");
        try js.write(headerValue(ref, ":method"));
        try js.objectField("version");
        try js.write("2");
        try js.objectField("headers_order");
        try js.beginArray();
        if (get(ref, &.{ "http", "headers_order" })) |ho| if (ho == .array) {
            for (ho.array.items) |n| if (n == .string and n.string.len > 0 and n.string[0] != ':') try js.write(n.string);
        };
        try js.endArray();
        try js.objectField("user_agent");
        try js.write(headerValue(ref, "user-agent"));
        try js.objectField("client_hints");
        try js.beginObject();
        try js.objectField("sec-ch-ua");
        try js.write(headerValue(ref, "sec-ch-ua"));
        try js.objectField("sec-ch-ua-mobile");
        try js.write(headerValue(ref, "sec-ch-ua-mobile"));
        try js.objectField("sec-ch-ua-platform");
        try js.write(headerValue(ref, "sec-ch-ua-platform"));
        try js.objectField("sec-ch-ua-full-version-list");
        try js.write(headerValue(ref, "sec-ch-ua-full-version-list"));
        try js.endObject();
        try js.objectField("accept");
        try js.write(headerValue(ref, "accept"));
        try js.objectField("accept_encoding");
        try js.write(headerValue(ref, "accept-encoding"));
        try js.objectField("accept_language");
        try js.write(headerValue(ref, "accept-language"));
        try js.objectField("sec_fetch_mode");
        try js.write(headerValue(ref, "sec-fetch-mode"));
        try js.objectField("sec_fetch_dest");
        try js.write(headerValue(ref, "sec-fetch-dest"));
        try js.objectField("checks");
        try writeOpt(js, get(ref, &.{ "http", "checks" }));
        try writeRoles(gpa, js, reports);
    }
    try js.endObject();

    // ---- tcp ----
    try js.objectField("tcp");
    try js.beginObject();
    {
        const syn = get(ref, &.{"tcp_syn"});
        try js.objectField("window_size");
        try writeOpt(js, if (syn) |s| get(s, &.{"window"}) else null);
        try js.objectField("options");
        try writeOpt(js, if (syn) |s| get(s, &.{"options"}) else null);
        try js.objectField("mss");
        try writeOpt(js, if (syn) |s| get(s, &.{"mss"}) else null);
        try js.objectField("window_scale");
        try writeOpt(js, if (syn) |s| get(s, &.{"window_scale"}) else null);
        try js.objectField("ttl_observed");
        try writeOpt(js, if (syn) |s| get(s, &.{"ttl"}) else null);
        try js.objectField("source");
        try js.write(if (syn != null) @as(?[]const u8, "pcap") else null);
    }
    try js.endObject();

    // ---- session ----
    try js.objectField("session");
    try js.beginObject();
    try js.objectField("resumption_observed");
    try js.write(resumed_idx != null);
    try js.objectField("resumed_ja4");
    try js.write(if (resumed_idx) |i| getStr(reports[i], &.{ "tls", "ja4", "ja4" }) else null);
    try js.objectField("resumed_session_reused");
    try js.write(if (resumed_idx) |i| getBool(reports[i], &.{ "tls", "handshake", "session_reused" }) else null);
    try js.objectField("connections_per_page_load");
    try js.write(null);
    try js.endObject();

    try js.objectField("notes");
    try js.write(meta.notes);
    try js.endObject();
}

/// The request role of a report: its own top-level `role` (set by whoever captured it, e.g. tabcap's echo:
/// "navigation", "fetch"), else "navigation" for sec-fetch-mode: navigate, else "other".
fn roleOf(r: Value) []const u8 {
    if (getStr(r, &.{"role"})) |role| return role;
    if (headerValue(r, "sec-fetch-mode")) |m| if (std.mem.eql(u8, m, "navigate")) return "navigation";
    return "other";
}

fn nonPseudoNamesEql(a: ?Value, b: ?Value) bool {
    const x = a orelse return b == null;
    const y = b orelse return false;
    if (x != .array or y != .array) return false;
    var i: usize = 0;
    var j: usize = 0;
    while (true) {
        while (i < x.array.items.len and isPseudo(x.array.items[i])) i += 1;
        while (j < y.array.items.len and isPseudo(y.array.items[j])) j += 1;
        if (i == x.array.items.len or j == y.array.items.len) return i == x.array.items.len and j == y.array.items.len;
        const xs = x.array.items[i];
        const ys = y.array.items[j];
        if (xs != .string or ys != .string or !std.mem.eql(u8, xs.string, ys.string)) return false;
        i += 1;
        j += 1;
    }
}

fn isPseudo(v: Value) bool {
    return v == .string and v.string.len > 0 and v.string[0] == ':';
}

/// `http.roles`: one header-order record per request role (a browser orders a navigation's headers
/// differently from a page's fetch), first-seen order of roles, first sample of each role as reference.
fn writeRoles(gpa: std.mem.Allocator, js: *Json, reports: []const Value) Error!void {
    var roles: std.ArrayList([]const u8) = .empty;
    defer roles.deinit(gpa);
    for (reports) |r| {
        const role = roleOf(r);
        for (roles.items) |x| {
            if (std.mem.eql(u8, x, role)) break;
        } else try roles.append(gpa, role);
    }
    try js.objectField("roles");
    try js.beginObject();
    for (roles.items) |role| {
        var first: ?Value = null;
        var samples: usize = 0;
        var stable = true;
        for (reports) |r| {
            if (!std.mem.eql(u8, roleOf(r), role)) continue;
            samples += 1;
            if (first) |f| {
                if (!nonPseudoNamesEql(get(f, &.{ "http", "headers_order" }), get(r, &.{ "http", "headers_order" }))) stable = false;
            } else first = r;
        }
        const ref = first orelse continue;
        try js.objectField(role);
        try js.beginObject();
        try js.objectField("samples");
        try js.write(samples);
        try js.objectField("method");
        try js.write(headerValue(ref, ":method"));
        try js.objectField("headers_order");
        try js.beginArray();
        if (get(ref, &.{ "http", "headers_order" })) |ho| if (ho == .array) {
            for (ho.array.items) |n| if (n == .string and !isPseudo(n)) try js.write(n.string);
        };
        try js.endArray();
        try js.objectField("headers_order_stable_across_samples");
        try js.write(stable);
        try js.objectField("accept");
        try js.write(headerValue(ref, "accept"));
        try js.objectField("sec_fetch_site");
        try js.write(headerValue(ref, "sec-fetch-site"));
        try js.objectField("sec_fetch_mode");
        try js.write(headerValue(ref, "sec-fetch-mode"));
        try js.objectField("sec_fetch_dest");
        try js.write(headerValue(ref, "sec-fetch-dest"));
        try js.endObject();
    }
    try js.endObject();
}

fn strLess(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

fn alpsCodepoint(ch: Value) ?[]const u8 {
    const order = get(ch, &.{"extensions_order"}) orelse return null;
    if (order != .array) return null;
    for (order.array.items) |x| {
        if (x != .string) continue;
        if (std.mem.eql(u8, x.string, "44cd")) return "44cd";
        if (std.mem.eql(u8, x.string, "4469")) return "4469";
    }
    return null;
}

fn settingValue(h2: Value, id: i64) ?i64 {
    const settings = get(h2, &.{"settings"}) orelse return null;
    if (settings != .array) return null;
    for (settings.array.items) |pair| {
        if (pair != .array or pair.array.items.len != 2) continue;
        if (pair.array.items[0] == .integer and pair.array.items[0].integer == id and pair.array.items[1] == .integer) return pair.array.items[1].integer;
    }
    return null;
}

/// True when every sample (optionally only non-PSK samples; all samples if none is PSK-free) has the same
/// string at `path`.
fn allSameString(reports: []const Value, path: []const []const u8, first_only: bool) bool {
    var any_first = false;
    for (reports) |r| if (!(getBool(r, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false)) {
        any_first = true;
    };
    var first: ?[]const u8 = null;
    for (reports) |r| {
        if (first_only and any_first and (getBool(r, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false)) continue;
        const s = getStr(r, path) orelse return false;
        if (first) |f| {
            if (!std.mem.eql(u8, f, s)) return false;
        } else first = s;
    }
    return first != null;
}

test "assemble builds a profile from two synthetic reports and flags extension permutation" {
    const gpa = std.testing.allocator;
    const a =
        \\{"tls":{"handshake":{"version":"TLSv1.3","cipher":"TLS_AES_128_GCM_SHA256","alpn":"h2","session_reused":false},
        \\ "client_hello":{"legacy_version":"0303","session_id_length":32,"cipher_suites":["1301","1302"],"cipher_grease_positions":[],"compression_methods":["00"],
        \\   "extension_count":3,"extensions_order":["0000","0010","002b"],"extension_grease_positions":[],"supported_versions":["0304"],"supported_groups":["11ec"],
        \\   "key_share_groups":["11ec"],"key_shares":[],"signature_algorithms":["0403"],"ec_point_formats":["00"],"alpn":["h2"],"server_name":"localhost",
        \\   "has_pre_shared_key":false,"has_encrypted_client_hello":true,"has_trust_anchors":true,"has_application_settings":true,"message_length":100},
        \\ "ja3":{"string":"771,4865,0-16-43,,","hash":"aa"},"ja4":{"ja4":"t13d0203h2_x_y","ja4_r":"r","ja4_o":"o","ja4_ro":"ro"}},
        \\ "http2":{"akamai":"1:65536|100|0|m,a,s,p","settings":[[1,65536],[9,1]],"window_update":100,"priority_frames":[],"pseudo_header_order":[":method",":authority",":scheme",":path"]},
        \\ "http":{"headers_order":[":method",":authority",":scheme",":path","user-agent","priority"],"headers":[{"name":":method","value":"GET"},{"name":"user-agent","value":"UA/1"},{"name":"priority","value":"u=0, i"}],"checks":[]}}
    ;
    const b =
        \\{"tls":{"handshake":{"version":"TLSv1.3","cipher":"TLS_AES_128_GCM_SHA256","alpn":"h2","session_reused":false},
        \\ "client_hello":{"legacy_version":"0303","session_id_length":32,"cipher_suites":["1301","1302"],"cipher_grease_positions":[],"compression_methods":["00"],
        \\   "extension_count":3,"extensions_order":["002b","0000","0010"],"extension_grease_positions":[],"supported_versions":["0304"],"supported_groups":["11ec"],
        \\   "key_share_groups":["11ec"],"key_shares":[],"signature_algorithms":["0403"],"ec_point_formats":["00"],"alpn":["h2"],"server_name":"localhost",
        \\   "has_pre_shared_key":false,"has_encrypted_client_hello":true,"has_trust_anchors":true,"has_application_settings":true,"message_length":100},
        \\ "ja3":{"string":"771,4865,43-0-16,,","hash":"bb"},"ja4":{"ja4":"t13d0203h2_x_y","ja4_r":"r","ja4_o":"o2","ja4_ro":"ro2"}},
        \\ "http2":{"akamai":"1:65536|100|0|m,a,s,p","settings":[[1,65536],[9,1]],"window_update":100,"priority_frames":[],"pseudo_header_order":[":method",":authority",":scheme",":path"]},
        \\ "http":{"headers_order":[":method","user-agent"],"headers":[{"name":":method","value":"GET"},{"name":"user-agent","value":"UA/1"}],"checks":[]}}
    ;
    var pa = try std.json.parseFromSlice(Value, gpa, a, .{});
    defer pa.deinit();
    var pb = try std.json.parseFromSlice(Value, gpa, b, .{});
    defer pb.deinit();
    var buf: [16384]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    var js: Json = .{ .writer = &w };
    try assemble(gpa, &js, &.{ pa.value, pb.value }, .{ .name = "chrome", .version = "153.0.8010.53", .os = "macos", .arch = "arm64", .channel = "stable" });
    const text = w.buffered();
    var parsed = try std.json.parseFromSlice(Value, gpa, text, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("chrome/153/macos-arm64/153.0.8010.53", getStr(parsed.value, &.{"id"}).?);
    try std.testing.expectEqual(true, getBool(parsed.value, &.{ "tls", "client_hello", "extension_order_randomized" }).?);
    try std.testing.expectEqual(false, getBool(parsed.value, &.{ "tls", "ja3", "stable_across_samples" }).?);
    try std.testing.expectEqual(true, getBool(parsed.value, &.{ "tls", "ja4", "stable_across_samples" }).?);
    try std.testing.expectEqual(@as(i64, 1), getInt(parsed.value, &.{ "http2", "no_rfc7540_priorities" }).?);
    try std.testing.expectEqual(true, getBool(parsed.value, &.{ "http2", "sends_priority_header" }).?);
    try std.testing.expect(get(parsed.value, &.{ "tls", "client_hello", "alps_codepoint" }).? == .null); // 44cd not in this synthetic order
    try std.testing.expectEqual(@as(usize, 2), get(parsed.value, &.{ "tls", "client_hello", "extensions_order_samples" }).?.array.items.len);
    try std.testing.expectEqualStrings("0000", get(parsed.value, &.{ "tls", "client_hello", "extensions_sorted" }).?.array.items[0].string);
}

test "GREASE values changing between samples do not count as extension-order randomization" {
    const gpa = std.testing.allocator;
    // Shape observed for Safari 26.6.2: leading + trailing GREASE differ, real order fixed.
    const a =
        \\{"tls":{"handshake":{"version":"TLSv1.3","session_reused":false},"client_hello":{"cipher_suites":["1301"],"extension_count":5,
        \\   "extensions_order":["5a5a","0000","0017","002b","1a1a"],"has_pre_shared_key":false},"ja4":{"ja4":"x"}},"http2":{},"http":{"headers_order":[],"headers":[]}}
    ;
    const b =
        \\{"tls":{"handshake":{"version":"TLSv1.3","session_reused":false},"client_hello":{"cipher_suites":["1301"],"extension_count":5,
        \\   "extensions_order":["eaea","0000","0017","002b","4a4a"],"has_pre_shared_key":false},"ja4":{"ja4":"x"}},"http2":{},"http":{"headers_order":[],"headers":[]}}
    ;
    var pa = try std.json.parseFromSlice(Value, gpa, a, .{});
    defer pa.deinit();
    var pb = try std.json.parseFromSlice(Value, gpa, b, .{});
    defer pb.deinit();
    var buf: [16384]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    var js: Json = .{ .writer = &w };
    try assemble(gpa, &js, &.{ pa.value, pb.value }, .{ .name = "safari", .version = "26.6.2", .os = "macos", .arch = "arm64" });
    var parsed = try std.json.parseFromSlice(Value, gpa, w.buffered(), .{});
    defer parsed.deinit();
    try std.testing.expectEqual(false, getBool(parsed.value, &.{ "tls", "client_hello", "extension_order_randomized" }).?);
    const sorted = get(parsed.value, &.{ "tls", "client_hello", "extensions_sorted" }).?.array.items;
    try std.testing.expectEqual(@as(usize, 3), sorted.len); // GREASE stripped
    try std.testing.expectEqualStrings("002b", sorted[2].string);
    // raw samples keep GREASE as sent
    try std.testing.expectEqualStrings("5a5a", get(parsed.value, &.{ "tls", "client_hello", "extensions_order_samples" }).?.array.items[0].array.items[0].string);
}

test "navigation and fetch reports keep two header-order roles; one sample leaves the order unknown" {
    const gpa = std.testing.allocator;
    const nav =
        \\{"role":"navigation","tls":{"client_hello":{"extensions_order":["0000","0010"],"has_pre_shared_key":false},"ja4":{"ja4":"x"}},"http2":{},
        \\ "http":{"headers_order":[":method",":path","sec-ch-ua","user-agent","accept","sec-fetch-mode"],"headers":[{"name":":method","value":"GET"},{"name":"sec-fetch-mode","value":"navigate"}]}}
    ;
    const fetch =
        \\{"role":"fetch","tls":{"client_hello":{"extensions_order":["0029","0000"],"has_pre_shared_key":true},"ja4":{"ja4":"y"}},"http2":{},
        \\ "http":{"headers_order":[":method",":path","sec-ch-ua","user-agent","accept","sec-fetch-mode","sec-fetch-dest"],"headers":[{"name":":method","value":"GET"},{"name":"sec-fetch-mode","value":"cors"}]}}
    ;
    var pa = try std.json.parseFromSlice(Value, gpa, nav, .{});
    defer pa.deinit();
    var pb = try std.json.parseFromSlice(Value, gpa, fetch, .{});
    defer pb.deinit();
    var buf: [16384]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    var js: Json = .{ .writer = &w };
    try assemble(gpa, &js, &.{ pa.value, pb.value }, .{ .name = "chrome", .version = "155.0.8059.79", .os = "macos", .arch = "arm64" });
    var parsed = try std.json.parseFromSlice(Value, gpa, w.buffered(), .{});
    defer parsed.deinit();
    // Only the first connection is judged (the fetch resumed with a PSK): one sample, order unknown.
    try std.testing.expectEqualStrings("unknown", getStr(parsed.value, &.{ "tls", "client_hello", "extension_order" }).?);
    try std.testing.expect(get(parsed.value, &.{ "tls", "client_hello", "extension_order_randomized" }).? == .null);
    const roles = get(parsed.value, &.{ "http", "roles" }).?.object;
    try std.testing.expectEqual(@as(usize, 2), roles.count());
    try std.testing.expectEqualStrings("navigation", roles.keys()[0]);
    try std.testing.expectEqualStrings("fetch", roles.keys()[1]);
    try std.testing.expectEqual(@as(usize, 4), get(roles.get("navigation").?, &.{"headers_order"}).?.array.items.len); // pseudo-headers left out
    try std.testing.expectEqual(@as(usize, 5), get(roles.get("fetch").?, &.{"headers_order"}).?.array.items.len);
    try std.testing.expectEqualStrings("cors", getStr(roles.get("fetch").?, &.{"sec_fetch_mode"}).?);
    // The top-level http section is still the navigation reference (what check's N1 reads).
    try std.testing.expectEqual(@as(usize, 4), get(parsed.value, &.{ "http", "headers_order" }).?.array.items.len);
}
