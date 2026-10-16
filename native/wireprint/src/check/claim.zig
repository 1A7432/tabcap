//! `wireprint check --claim <profile.json> <report.json>`: compares one observed connection
//! (a `report` output) against a corpus profile the client claims to be, layer by layer, and reports where
//! they disagree. Rules are deliberately about RAW fields, not only hashes (hash matching
//! breaks on Finch variants; field presence/order is what impersonation libraries get wrong).
//!
//!   TLS   T1 JA4 differs            T2 cipher list differs (set / order)   T3 extension set differs
//!         T4 extension order fixed but differs (only when the profile's order is "fixed"; skipped, as an
//!            info line, when it is "unknown" because the profile judged fewer than two samples)
//!         T5 supported_groups / key_share groups differ   T6 signature_algorithms differ
//!         T7 ALPN list differs      T8 presence flags differ (ECH, trust_anchors, ALPS codepoint)
//!   H2    A1 Akamai string differs  A2 SETTINGS pairs differ   A3 WINDOW_UPDATE differs
//!         A4 pseudo-header order differs
//!   HTTP  N1 header order differs (navigation requests only)   N2 UA major differs from profile UA
//!         N3 Client Hints presence differs  + the intrinsic H1..H5 rules from check/headers.zig
//! Severity: red = a discrepancy a bot detector could key on; warn = probably benign (e.g. sub-resource
//! request compared to a navigation profile); info = context.
const std = @import("std");
const Value = std.json.Value;
const headers_check = @import("headers.zig");
const jdiff = @import("../diff.zig");

pub const Finding = headers_check.Finding;

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

fn headerValue(report: Value, name: []const u8) ?[]const u8 {
    const headers = get(report, &.{ "http", "headers" }) orelse return null;
    if (headers != .array) return null;
    for (headers.array.items) |h| {
        const n = getStr(h, &.{"name"}) orelse continue;
        if (std.ascii.eqlIgnoreCase(n, name)) return getStr(h, &.{"value"});
    }
    return null;
}

fn push(arena: std.mem.Allocator, out: *std.ArrayList(Finding), rule: []const u8, severity: headers_check.Severity, comptime fmt: []const u8, args: anytype) std.mem.Allocator.Error!void {
    try out.append(arena, .{ .rule = rule, .severity = severity, .message = try std.fmt.allocPrint(arena, fmt, args) });
}

fn fmtValue(arena: std.mem.Allocator, v: ?Value) std.mem.Allocator.Error![]const u8 {
    const x = v orelse return "null";
    var aw: std.Io.Writer.Allocating = .init(arena);
    std.json.Stringify.value(x, .{}, &aw.writer) catch return "?";
    return aw.written();
}

const ArrayCmp = enum { equal, reordered, different, missing };

fn isGreaseHex(str: []const u8) bool {
    return str.len == 4 and str[0] == str[2] and str[1] == str[3] and str[1] == 'a';
}

/// Copies a JSON string array without GREASE values (random per connection, RFC 8701) and, when
/// `drop_psk` is set, without 0029 (pre_shared_key only appears on resumption).
fn normalized(arena: std.mem.Allocator, v: ?Value, drop_psk: bool) std.mem.Allocator.Error!?Value {
    const x = v orelse return null;
    if (x != .array) return null;
    var out: std.json.Array = .init(arena);
    for (x.array.items) |item| {
        if (item == .string and (isGreaseHex(item.string) or (drop_psk and std.mem.eql(u8, item.string, "0029")))) continue;
        try out.append(item);
    }
    return .{ .array = out };
}

fn cmpStringArrays(a: ?Value, b: ?Value) ArrayCmp {
    const x = a orelse return .missing;
    const y = b orelse return .missing;
    if (x != .array or y != .array) return .missing;
    if (jdiff.equal(x, y)) return .equal;
    if (x.array.items.len != y.array.items.len) return .different;
    for (x.array.items) |xi| {
        var found = false;
        for (y.array.items) |yi| if (jdiff.equal(xi, yi)) {
            found = true;
            break;
        };
        if (!found) return .different;
    }
    return .reordered;
}

/// Non-pseudo header names of a report/profile as a JSON array value (profile stores them already filtered).
fn headerNames(arena: std.mem.Allocator, v: Value, path: []const []const u8) std.mem.Allocator.Error!?Value {
    const arr = get(v, path) orelse return null;
    if (arr != .array) return null;
    var out: std.json.Array = .init(arena);
    for (arr.array.items) |n| {
        if (n == .string and n.string.len > 0 and n.string[0] != ':') try out.append(n);
    }
    return .{ .array = out };
}

/// Compares `report` (a `report` output or `parse` output) against `profile` (corpus profile).
pub fn checkClaim(arena: std.mem.Allocator, report: Value, profile: Value, out: *std.ArrayList(Finding)) std.mem.Allocator.Error!void {
    const id = getStr(profile, &.{"id"}) orelse "?";
    try push(arena, out, "I0", .info, "claim: {s}", .{id});

    // ---- TLS ----
    const r_ja4 = getStr(report, &.{ "tls", "ja4", "ja4" });
    // A resumed connection carries pre_shared_key (0029): JA4_a's extension count goes up by one and JA4_c
    // changes, so the profile's `session.resumed_ja4` is the right reference when the report has a PSK.
    const r_psk = getBool(report, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false;
    const p_first = getStr(profile, &.{ "tls", "ja4", "ja4" });
    const p_resumed = getStr(profile, &.{ "session", "resumed_ja4" });
    const p_ja4 = if (r_psk and p_resumed != null) p_resumed else p_first;
    if (r_ja4 != null and p_ja4 != null and !std.mem.eql(u8, r_ja4.?, p_ja4.?)) {
        if (r_psk and p_resumed == null) {
            try push(arena, out, "T1", .warn, "JA4 {s} != profile {s} [resumed connection; profile has no resumed sample]", .{ r_ja4.?, p_ja4.? });
        } else {
            try push(arena, out, "T1", .red, "JA4 {s} != profile {s}{s}", .{ r_ja4.?, p_ja4.?, if (r_psk) " [resumed]" else "" });
        }
    } else if (r_ja4 != null and p_ja4 != null) {
        try push(arena, out, "T1", .info, "JA4 matches ({s}){s}", .{ r_ja4.?, if (r_psk) " [resumed]" else "" });
    }
    const rch = get(report, &.{ "tls", "client_hello" }) orelse .null;
    const pch = get(profile, &.{ "tls", "client_hello" }) orelse .null;

    {
        const rc = try normalized(arena, get(rch, &.{"cipher_suites"}), false);
        const pc = try normalized(arena, get(pch, &.{"cipher_suites"}), false);
        switch (cmpStringArrays(rc, pc)) {
            .equal => {},
            .reordered => try push(arena, out, "T2", .red, "cipher suites: same set, different order", .{}),
            .different => try push(arena, out, "T2", .red, "cipher suites differ (GREASE removed): observed {s} vs profile {s}", .{ try fmtValue(arena, rc), try fmtValue(arena, pc) }),
            .missing => {},
        }
    }
    // Extension set: compare sorted lists with GREASE and pre_shared_key removed (profile: extensions_sorted).
    if (try normalized(arena, get(rch, &.{"extensions_order"}), true)) |ro| if (try normalized(arena, get(pch, &.{"extensions_sorted"}), true)) |ps| {
        var sorted: std.json.Array = .init(arena);
        for (ro.array.items) |x| try sorted.append(x);
        std.mem.sort(Value, sorted.items, {}, valueStrLess);
        const rs: Value = .{ .array = sorted };
        const order_unknown = if (getStr(pch, &.{"extension_order"})) |eo| std.mem.eql(u8, eo, "unknown") else false;
        if (!jdiff.equal(rs, ps)) {
            try push(arena, out, "T3", .red, "extension set differs (GREASE/PSK removed): observed {s} vs profile {s}", .{ try fmtValue(arena, rs), try fmtValue(arena, ps) });
        } else if (order_unknown) {
            // Fewer than two samples could not tell a fixed order from a random one: T4 is not judged.
            try push(arena, out, "T4", .info, "extension order not compared: the profile's order is unknown (fewer than 2 samples)", .{});
        } else if (!(getBool(pch, &.{"extension_order_randomized"}) orelse false)) {
            // Profile says the order is stable: compare against the first recorded order.
            if (get(pch, &.{"extensions_order_samples"})) |samples| if (samples == .array and samples.array.items.len > 0) {
                const first = try normalized(arena, samples.array.items[0], true);
                if (first != null and !jdiff.equal(ro, first.?)) {
                    // A single-sample profile cannot know whether the client permutes extensions (Chrome does).
                    const n = getInt(profile, &.{ "capture", "samples" }) orelse 1;
                    if (n >= 2) {
                        try push(arena, out, "T4", .red, "extension order differs from a profile with fixed order ({d} samples)", .{n});
                    } else {
                        try push(arena, out, "T4", .warn, "extension order differs; profile has a single sample so order stability is unknown", .{});
                    }
                }
            };
        }
    };
    inline for (.{ .{ "supported_groups", "T5" }, .{ "key_share_groups", "T5" }, .{ "signature_algorithms", "T6" }, .{ "alpn", "T7" }, .{ "supported_versions", "T7" } }) |pair| {
        const rv = try normalized(arena, get(rch, &.{pair[0]}), false);
        const pv = try normalized(arena, get(pch, &.{pair[0]}), false);
        switch (cmpStringArrays(rv, pv)) {
            .equal, .missing => {},
            .reordered => try push(arena, out, pair[1], .red, "{s}: same set, different order", .{pair[0]}),
            .different => try push(arena, out, pair[1], .red, "{s} differ (GREASE removed): observed {s} vs profile {s}", .{ pair[0], try fmtValue(arena, rv), try fmtValue(arena, pv) }),
        }
    }
    inline for (.{ .{ "has_encrypted_client_hello", "ech_present", "ECH extension" }, .{ "has_trust_anchors", "trust_anchors_present", "trust_anchors extension" } }) |t| {
        const rv = getBool(rch, &.{t[0]});
        const pv = getBool(pch, &.{t[1]});
        if (rv != null and pv != null and rv.? != pv.?) {
            try push(arena, out, "T8", .red, "{s}: observed {} vs profile {}", .{ t[2], rv.?, pv.? });
        }
    }
    {
        const r_alps: ?[]const u8 = blk: {
            const order = get(rch, &.{"extensions_order"}) orelse break :blk null;
            if (order != .array) break :blk null;
            for (order.array.items) |x| if (x == .string) {
                if (std.mem.eql(u8, x.string, "44cd")) break :blk "44cd";
                if (std.mem.eql(u8, x.string, "4469")) break :blk "4469";
            };
            break :blk null;
        };
        const p_alps = getStr(pch, &.{"alps_codepoint"});
        if ((r_alps == null) != (p_alps == null) or (r_alps != null and p_alps != null and !std.mem.eql(u8, r_alps.?, p_alps.?))) {
            try push(arena, out, "T8", .red, "ALPS codepoint: observed {s} vs profile {s}", .{ r_alps orelse "none", p_alps orelse "none" });
        }
    }

    // ---- HTTP/2 ----
    const r_ak = getStr(report, &.{ "http2", "akamai" });
    const p_ak = getStr(profile, &.{ "http2", "akamai" });
    if (r_ak != null and p_ak != null) {
        if (!std.mem.eql(u8, r_ak.?, p_ak.?)) {
            try push(arena, out, "A1", .red, "Akamai h2 fingerprint {s} != profile {s}", .{ r_ak.?, p_ak.? });
            switch (cmpStringArrays(get(report, &.{ "http2", "settings" }), get(profile, &.{ "http2", "settings" }))) {
                .equal, .missing => {},
                .reordered => try push(arena, out, "A2", .red, "SETTINGS: same pairs, different order", .{}),
                .different => try push(arena, out, "A2", .red, "SETTINGS differ: observed {s} vs profile {s}", .{ try fmtValue(arena, get(report, &.{ "http2", "settings" })), try fmtValue(arena, get(profile, &.{ "http2", "settings" })) }),
            }
            const rw = getInt(report, &.{ "http2", "window_update" });
            const pw = getInt(profile, &.{ "http2", "window_update" });
            if (rw != null and pw != null and rw.? != pw.?) try push(arena, out, "A3", .red, "WINDOW_UPDATE {d} vs profile {d}", .{ rw.?, pw.? });
            if (cmpStringArrays(get(report, &.{ "http2", "pseudo_header_order" }), get(profile, &.{ "http2", "pseudo_header_order" })) == .reordered) {
                try push(arena, out, "A4", .red, "pseudo-header order differs", .{});
            }
        } else {
            try push(arena, out, "A1", .info, "Akamai h2 fingerprint matches", .{});
        }
    }

    // ---- HTTP ----
    const r_mode = headerValue(report, "sec-fetch-mode");
    const is_nav = r_mode != null and std.mem.eql(u8, r_mode.?, "navigate");
    const rh = try headerNames(arena, report, &.{ "http", "headers_order" });
    const ph = get(profile, &.{ "http", "headers_order" });
    switch (cmpStringArrays(rh, ph)) {
        .equal, .missing => {},
        .reordered => try push(arena, out, "N1", if (is_nav) .red else .warn, "header order differs (same names){s}", .{if (is_nav) "" else " [sub-resource request compared to a navigation profile]"}),
        .different => try push(arena, out, "N1", if (is_nav) .red else .warn, "header names differ: observed {s} vs profile {s}{s}", .{ try fmtValue(arena, rh), try fmtValue(arena, ph), if (is_nav) "" else " [sub-resource request]" }),
    }
    const r_ua = headerValue(report, "user-agent");
    const p_ua = getStr(profile, &.{ "http", "user_agent" });
    if (r_ua != null and p_ua != null) {
        const rv = headers_check.uaMajorVersion(r_ua.?);
        const pv = headers_check.uaMajorVersion(p_ua.?);
        if (rv != null and pv != null and !std.mem.eql(u8, rv.?, pv.?)) {
            try push(arena, out, "N2", .red, "user-agent major {s} vs profile {s}", .{ rv.?, pv.? });
        }
        if (headers_check.uaFamily(r_ua.?) != headers_check.uaFamily(p_ua.?)) {
            try push(arena, out, "N2", .red, "user-agent family {t} vs profile {t}", .{ headers_check.uaFamily(r_ua.?), headers_check.uaFamily(p_ua.?) });
        }
    }
    const r_ch = headerValue(report, "sec-ch-ua") != null;
    const p_ch = getStr(profile, &.{ "http", "client_hints", "sec-ch-ua" }) != null;
    if (r_ch != p_ch) try push(arena, out, "N3", .red, "sec-ch-ua presence: observed {} vs profile {}", .{ r_ch, p_ch });
    try headers_check.uaVersusClientHints(arena, r_ua, headerValue(report, "sec-ch-ua"), headerValue(report, "sec-ch-ua-platform"), out);
}

fn valueStrLess(_: void, a: Value, b: Value) bool {
    const as = if (a == .string) a.string else "";
    const bs = if (b == .string) b.string else "";
    return std.mem.lessThan(u8, as, bs);
}

pub fn writeFindings(js: *std.json.Stringify, findings: []const Finding) !void {
    try js.beginArray();
    for (findings) |f| {
        try js.beginObject();
        try js.objectField("rule");
        try js.write(f.rule);
        try js.objectField("severity");
        try js.write(@tagName(f.severity));
        try js.objectField("message");
        try js.write(f.message);
        try js.endObject();
    }
    try js.endArray();
}

test "checkClaim flags TLS / h2 / header discrepancies and stays quiet on a match" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const profile_text =
        \\{"id":"chrome/153/macos-arm64/153.0.8010.53","tls":{"ja4":{"ja4":"t13d1517h2_a_b"},"client_hello":{"cipher_suites":["1301","1302"],"extensions_sorted":["0000","0010","44cd","ca34"],"extension_order_randomized":true,"extensions_order_samples":[["ca34","0000","44cd","0010"]],"supported_groups":["11ec","001d"],"key_share_groups":["11ec","001d"],"signature_algorithms":["0403"],"alpn":["h2","http/1.1"],"supported_versions":["0304","0303"],"ech_present":true,"trust_anchors_present":true,"alps_codepoint":"44cd"}},
        \\ "http2":{"akamai":"1:65536;2:0|15663105|0|m,a,s,p","settings":[[1,65536],[2,0]],"window_update":15663105,"pseudo_header_order":[":method",":authority",":scheme",":path"]},
        \\ "http":{"headers_order":["sec-ch-ua","user-agent","accept"],"user_agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36","client_hints":{"sec-ch-ua":"\"Google Chrome\";v=\"153\""}}}
    ;
    const same =
        \\{"tls":{"ja4":{"ja4":"t13d1517h2_a_b"},"client_hello":{"cipher_suites":["3a3a","1301","1302"],"extensions_order":["9a9a","0010","ca34","44cd","0000","0029"],"supported_groups":["2a2a","11ec","001d"],"key_share_groups":["2a2a","11ec","001d"],"signature_algorithms":["0403"],"alpn":["h2","http/1.1"],"supported_versions":["0304","0303"],"has_encrypted_client_hello":true,"has_trust_anchors":true}},
        \\ "http2":{"akamai":"1:65536;2:0|15663105|0|m,a,s,p","settings":[[1,65536],[2,0]],"window_update":15663105,"pseudo_header_order":[":method",":authority",":scheme",":path"]},
        \\ "http":{"headers_order":[":method","sec-ch-ua","user-agent","accept"],"headers":[{"name":"sec-ch-ua","value":"\"Google Chrome\";v=\"153\", \"Not/A)Brand\";v=\"24\""},{"name":"user-agent","value":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"},{"name":"sec-fetch-mode","value":"navigate"}]}}
    ;
    const impostor =
        \\{"tls":{"ja4":{"ja4":"t13d1515h2_a_c"},"client_hello":{"cipher_suites":["1301","1302"],"extensions_order":["0000","0010"],"supported_groups":["11ec","001d"],"key_share_groups":["11ec","001d"],"signature_algorithms":["0403"],"alpn":["h2","http/1.1"],"supported_versions":["0304","0303"],"has_encrypted_client_hello":true,"has_trust_anchors":false}},
        \\ "http2":{"akamai":"1:65536;2:0|15663105|0|m,a,s,p","settings":[[1,65536],[2,0]],"window_update":15663105,"pseudo_header_order":[":method",":authority",":scheme",":path"]},
        \\ "http":{"headers_order":[":method","user-agent","accept","sec-ch-ua"],"headers":[{"name":"user-agent","value":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"},{"name":"sec-ch-ua","value":"\"Google Chrome\";v=\"150\""},{"name":"sec-fetch-mode","value":"navigate"}]}}
    ;
    const p = try std.json.parseFromSliceLeaky(Value, arena, profile_text, .{});
    const s = try std.json.parseFromSliceLeaky(Value, arena, same, .{});
    const i = try std.json.parseFromSliceLeaky(Value, arena, impostor, .{});

    var f: std.ArrayList(Finding) = .empty;
    try checkClaim(arena, s, p, &f);
    for (f.items) |x| {
        if (x.severity == .red) std.debug.print("UNEXPECTED RED on identical report: {s} {s}\n", .{ x.rule, x.message });
        try std.testing.expect(x.severity != .red);
    }

    f = .empty;
    try checkClaim(arena, i, p, &f);
    var rules: std.ArrayList([]const u8) = .empty;
    for (f.items) |x| if (x.severity == .red) try rules.append(arena, x.rule);
    const expect_rules = [_][]const u8{ "T1", "T3", "T8", "N1", "N2" };
    for (expect_rules) |er| {
        var found = false;
        for (rules.items) |r| if (std.mem.eql(u8, r, er)) {
            found = true;
        };
        if (!found) {
            std.debug.print("missing rule {s}; got:\n", .{er});
            for (f.items) |x| std.debug.print("  {t} {s} {s}\n", .{ x.severity, x.rule, x.message });
        }
        try std.testing.expect(found);
    }
}

test "T1 compares a resumed (PSK) report against session.resumed_ja4" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const with_resumed =
        \\{"id":"chrome/153/macos-arm64/153.0.8010.53","tls":{"ja4":{"ja4":"t13d1517h2_a_b"},"client_hello":{}},"session":{"resumed_ja4":"t13d1518h2_a_c"}}
    ;
    const without_resumed =
        \\{"id":"chrome/153/macos-arm64/153.0.8010.53","tls":{"ja4":{"ja4":"t13d1517h2_a_b"},"client_hello":{}}}
    ;
    const resumed_report =
        \\{"tls":{"ja4":{"ja4":"t13d1518h2_a_c"},"client_hello":{"has_pre_shared_key":true}}}
    ;
    const p1 = try std.json.parseFromSliceLeaky(Value, arena, with_resumed, .{});
    const p2 = try std.json.parseFromSliceLeaky(Value, arena, without_resumed, .{});
    const r = try std.json.parseFromSliceLeaky(Value, arena, resumed_report, .{});

    var f: std.ArrayList(Finding) = .empty;
    try checkClaim(arena, r, p1, &f);
    for (f.items) |x| if (std.mem.eql(u8, x.rule, "T1")) try std.testing.expectEqual(headers_check.Severity.info, x.severity);

    f = .empty;
    try checkClaim(arena, r, p2, &f);
    var seen = false;
    for (f.items) |x| if (std.mem.eql(u8, x.rule, "T1")) {
        seen = true;
        try std.testing.expectEqual(headers_check.Severity.warn, x.severity);
    };
    try std.testing.expect(seen);
}
