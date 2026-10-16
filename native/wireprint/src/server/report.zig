//! JSON report writers shared by `wireprint parse`, `wireprint h2` and the echo server.
//! Field names follow spec/profile-schema.md (tls.client_hello.*, tls.ja3, tls.ja4.{ja4,ja4_r,ja4_o,ja4_ro},
//! http2.*, http.*, tcp.*); hex is lowercase, u16 values are 4 digits (src/hex.zig).
//! Header VALUES are only printed for an allow-list of fingerprint-relevant headers (fixtures/README.md:
//! never store cookies or credentials); names and their order are always printed.
const std = @import("std");
const hex = @import("../hex.zig");
const client_hello = @import("../tls/client_hello.zig");
const grease = @import("../tls/grease.zig");
const tcp_reassembly = @import("../net/tcp_reassembly.zig");
const eth_ip_tcp = @import("../net/eth_ip_tcp.zig");
const ja3 = @import("../fp/ja3.zig");
const ja4 = @import("../fp/ja4.zig");
const akamai = @import("../fp/akamai.zig");
const frame = @import("../h2/frame.zig");
const hpack = @import("../h2/hpack.zig");
const check_headers = @import("../check/headers.zig");

pub const Json = std.json.Stringify;

pub fn u16List(js: *Json, list: client_hello.U16List) !void {
    try js.beginArray();
    var i: usize = 0;
    while (i < list.len()) : (i += 1) try js.write(&hex.u16Hex(list.at(i)));
    try js.endArray();
}

pub fn hexBytes(gpa: std.mem.Allocator, js: *Json, bytes: []const u8) !void {
    const h = try hex.encodeAlloc(gpa, bytes);
    defer gpa.free(h);
    try js.write(h);
}

/// "client_hello" object: every raw field the profile schema stores.
pub fn clientHello(gpa: std.mem.Allocator, js: *Json, ch: *const client_hello.ClientHello) !void {
    try js.beginObject();
    try js.objectField("legacy_version");
    try js.write(&hex.u16Hex(ch.legacy_version));
    try js.objectField("random");
    try hexBytes(gpa, js, ch.random);
    try js.objectField("session_id");
    try hexBytes(gpa, js, ch.session_id);
    try js.objectField("session_id_length");
    try js.write(ch.session_id.len);

    try js.objectField("cipher_suites");
    try u16List(js, ch.cipher_suites);
    try js.objectField("cipher_grease_positions");
    try js.beginArray();
    {
        var i: usize = 0;
        while (i < ch.cipher_suites.len()) : (i += 1) if (grease.isGrease(ch.cipher_suites.at(i))) try js.write(i);
    }
    try js.endArray();

    try js.objectField("compression_methods");
    try js.beginArray();
    for (ch.compression_methods) |m| try js.write(&hex.u8Hex(m));
    try js.endArray();

    try js.objectField("extension_count");
    try js.write(ch.extension_count);
    try js.objectField("extensions");
    try js.beginArray();
    var grease_positions: std.ArrayList(usize) = .empty;
    defer grease_positions.deinit(gpa);
    {
        var iter = ch.iterateExtensions();
        var idx: usize = 0;
        while (try iter.next()) |e| : (idx += 1) {
            try js.beginObject();
            try js.objectField("type");
            try js.write(&hex.u16Hex(e.kind));
            try js.objectField("length");
            try js.write(e.data.len);
            try js.endObject();
            if (grease.isGrease(e.kind)) try grease_positions.append(gpa, idx);
        }
    }
    try js.endArray();
    try js.objectField("extensions_order");
    try js.beginArray();
    {
        var iter = ch.iterateExtensions();
        while (try iter.next()) |e| try js.write(&hex.u16Hex(e.kind));
    }
    try js.endArray();
    try js.objectField("extension_grease_positions");
    try js.write(grease_positions.items);

    try js.objectField("server_name");
    try js.write(try ch.serverName());
    try js.objectField("alpn");
    if (try ch.alpn()) |protos| {
        var p = protos;
        try js.beginArray();
        while (try p.next()) |name| try js.write(name);
        try js.endArray();
    } else try js.write(null);
    try js.objectField("supported_versions");
    if (try ch.supportedVersions()) |l| try u16List(js, l) else try js.write(null);
    try js.objectField("supported_groups");
    if (try ch.supportedGroups()) |l| try u16List(js, l) else try js.write(null);
    try js.objectField("signature_algorithms");
    if (try ch.signatureAlgorithms()) |l| try u16List(js, l) else try js.write(null);
    try js.objectField("key_share_groups");
    if (try ch.keyShares()) |ks| {
        var k = ks;
        try js.beginArray();
        while (try k.next()) |e| try js.write(&hex.u16Hex(e.group));
        try js.endArray();
    } else try js.write(null);
    try js.objectField("key_shares");
    if (try ch.keyShares()) |ks| {
        var k = ks;
        try js.beginArray();
        while (try k.next()) |e| {
            try js.beginObject();
            try js.objectField("group");
            try js.write(&hex.u16Hex(e.group));
            try js.objectField("key_exchange_length");
            try js.write(e.key_exchange.len);
            try js.endObject();
        }
        try js.endArray();
    } else try js.write(null);
    try js.objectField("ec_point_formats");
    if (try ch.ecPointFormats()) |f| {
        try js.beginArray();
        for (f) |b| try js.write(&hex.u8Hex(b));
        try js.endArray();
    } else try js.write(null);
    try js.objectField("has_pre_shared_key");
    try js.write(ch.findExtension(client_hello.ext.pre_shared_key) != null);
    try js.objectField("has_encrypted_client_hello");
    try js.write(ch.findExtension(client_hello.ext.encrypted_client_hello) != null);
    try js.objectField("has_trust_anchors");
    try js.write(ch.findExtension(client_hello.ext.trust_anchors) != null);
    try js.objectField("has_application_settings");
    try js.write(ch.findExtension(client_hello.ext.application_settings) != null or ch.findExtension(client_hello.ext.application_settings_old) != null);
    try js.objectField("message_length");
    try js.write(ch.message.len);
    try js.endObject();
}

pub const Which = enum { both, ja3, ja4 };

/// "ja3" and/or "ja4" objects (errors are reported inline as strings, never abort the report).
pub fn fingerprints(gpa: std.mem.Allocator, js: *Json, ch: *const client_hello.ClientHello, transport: ja4.Transport, which: Which) !void {
    if (which != .ja4) {
        try js.objectField("ja3");
        if (ja3.compute(gpa, ch)) |res| {
            var r = res;
            defer r.deinit(gpa);
            try js.beginObject();
            try js.objectField("string");
            try js.write(r.string);
            try js.objectField("hash");
            try js.write(&r.hash);
            try js.endObject();
        } else |err| {
            try js.print("\"error: {t}\"", .{err});
        }
    }
    if (which != .ja3) {
        try js.objectField("ja4");
        if (ja4.compute(gpa, ch, transport)) |res| {
            var r = res;
            defer r.deinit(gpa);
            try js.beginObject();
            try js.objectField("ja4");
            try js.write(r.ja4);
            try js.objectField("ja4_r");
            try js.write(r.ja4_r);
            try js.objectField("ja4_o");
            try js.write(r.ja4_o);
            try js.objectField("ja4_ro");
            try js.write(r.ja4_ro);
            try js.endObject();
        } else |err| {
            try js.print("\"error: {t}\"", .{err});
        }
    }
}

/// "tcp_syn" object from a reassembled flow's SYN (pcap path) — window, ttl, options in wire order, mss, wscale.
pub fn tcpSyn(gpa: std.mem.Allocator, js: *Json, syn: tcp_reassembly.SynInfo) !void {
    try js.beginObject();
    try js.objectField("window");
    try js.write(syn.window);
    try js.objectField("ttl");
    try js.write(syn.ttl);
    try js.objectField("options_hex");
    try hexBytes(gpa, js, syn.options);
    try js.objectField("options");
    try js.beginArray();
    var mss: ?u16 = null;
    var wscale: ?u8 = null;
    var iter = eth_ip_tcp.TcpOptionIterator{ .bytes = syn.options };
    while (iter.next() catch null) |opt| {
        try js.write(opt.kind);
        if (opt.kind == 2 and opt.data.len == 2) mss = std.mem.readInt(u16, opt.data[0..2], .big);
        if (opt.kind == 3 and opt.data.len == 1) wscale = opt.data[0];
    }
    try js.endArray();
    try js.objectField("mss");
    try js.write(mss);
    try js.objectField("window_scale");
    try js.write(wscale);
    try js.endObject();
}

/// Everything the fingerprint layer needs from a client's HTTP/2 stream up to its first request.
pub const H2Observation = struct {
    frame_headers: []const frame.FrameHeader,
    settings: []const akamai.Setting,
    window_update: ?u32,
    priorities: []const akamai.PriorityRecord,
    headers: []const hpack.Header,
    headers_stream_id: ?u31,
    hpack_error: ?[]const u8,
    /// Set when the stream ended (or errored) before a complete header block.
    frame_error: ?[]const u8,
};

/// Walks `bytes` (client stream WITHOUT the 24-byte preface) up to and including the first complete request
/// header block and decodes it. Scope rules (project decision): every non-ACK SETTINGS
/// before the first HEADERS is concatenated; only the first stream-0 WINDOW_UPDATE counts; a PRIORITY
/// flag inside HEADERS is not a PRIORITY frame. Everything is allocated in `arena`.
pub fn collectH2(arena: std.mem.Allocator, bytes: []const u8) std.mem.Allocator.Error!H2Observation {
    var frame_headers: std.ArrayList(frame.FrameHeader) = .empty;
    var settings_list: std.ArrayList(akamai.Setting) = .empty;
    var priorities: std.ArrayList(akamai.PriorityRecord) = .empty;
    var headers: std.ArrayList(hpack.Header) = .empty;
    var block: std.ArrayList(u8) = .empty;
    var window_update: ?u32 = null;
    var headers_stream: ?u31 = null;
    var have_headers = false;
    var frame_error: ?[]const u8 = null;
    var hpack_error: ?[]const u8 = null;

    var iter = frame.FrameIterator{ .bytes = bytes };
    while (!have_headers) {
        const f = iter.next() catch |err| {
            frame_error = @errorName(err);
            break;
        } orelse break;
        try frame_headers.append(arena, f.header);
        const kind: frame.FrameType = @enumFromInt(f.header.type);
        switch (kind) {
            .settings => if (f.header.flags & frame.Flags.ack == 0) {
                var s = frame.settings(f) catch |err| {
                    frame_error = @errorName(err);
                    break;
                };
                while (s.next()) |st| try settings_list.append(arena, .{ .id = st.id, .value = st.value });
            },
            .window_update => if (f.header.stream_id == 0 and window_update == null) {
                window_update = frame.windowUpdate(f) catch |err| {
                    frame_error = @errorName(err);
                    break;
                };
            },
            .priority => {
                const p = frame.priority(f) catch |err| {
                    frame_error = @errorName(err);
                    break;
                };
                try priorities.append(arena, .{ .stream_id = f.header.stream_id, .exclusive = p.exclusive, .dependency = p.dependency, .weight = p.weight });
            },
            .headers => {
                const h = frame.headers(f) catch |err| {
                    frame_error = @errorName(err);
                    break;
                };
                headers_stream = f.header.stream_id;
                try block.appendSlice(arena, h.fragment);
                if (h.end_headers) have_headers = true;
            },
            .continuation => if (headers_stream != null) {
                const c = frame.continuation(f) catch |err| {
                    frame_error = @errorName(err);
                    break;
                };
                try block.appendSlice(arena, c);
                if (f.header.flags & frame.Flags.end_headers != 0) have_headers = true;
            },
            else => {},
        }
    }

    if (block.items.len > 0) {
        var decoder = hpack.Decoder.init(arena, 4096);
        defer decoder.deinit();
        decoder.decodeBlock(block.items, arena, &headers) catch |err| {
            hpack_error = @errorName(err);
        };
    }

    return .{
        .frame_headers = frame_headers.items,
        .settings = settings_list.items,
        .window_update = window_update,
        .priorities = priorities.items,
        .headers = headers.items,
        .headers_stream_id = headers_stream,
        .hpack_error = hpack_error,
        .frame_error = frame_error,
    };
}

fn isPrintableValueHeader(name: []const u8) bool {
    const allow = [_][]const u8{ "user-agent", "accept", "accept-language", "accept-encoding", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-full-version-list", "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-model", "sec-ch-ua-platform-version", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "upgrade-insecure-requests", "priority", "te", "dnt", "sec-gpc", "cache-control", "pragma", "connection", "host" };
    for (allow) |a| if (std.ascii.eqlIgnoreCase(a, name)) return true;
    return false;
}

pub fn findHeader(headers: []const hpack.Header, name: []const u8) ?[]const u8 {
    for (headers) |h| if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
    return null;
}

/// "http2" object (frames, settings, window update, priorities, pseudo-header order, akamai string).
pub fn http2(arena: std.mem.Allocator, js: *Json, obs: H2Observation) !void {
    try js.beginObject();
    try js.objectField("frames");
    try js.beginArray();
    for (obs.frame_headers) |h| {
        try js.beginObject();
        try js.objectField("type");
        try js.write(h.type);
        try js.objectField("type_name");
        try js.write(@tagName(@as(frame.FrameType, @enumFromInt(h.type))));
        try js.objectField("length");
        try js.write(h.length);
        try js.objectField("flags");
        try js.write(&hex.u8Hex(h.flags));
        try js.objectField("stream_id");
        try js.write(h.stream_id);
        try js.endObject();
    }
    try js.endArray();
    if (obs.frame_error) |e| {
        try js.objectField("frame_error");
        try js.write(e);
    }
    try js.objectField("settings");
    try js.beginArray();
    for (obs.settings) |s| {
        try js.beginArray();
        try js.write(s.id);
        try js.write(s.value);
        try js.endArray();
    }
    try js.endArray();
    try js.objectField("window_update");
    try js.write(obs.window_update);
    try js.objectField("priority_frames");
    try js.beginArray();
    for (obs.priorities) |p| {
        try js.beginArray();
        try js.write(p.stream_id);
        try js.write(@intFromBool(p.exclusive));
        try js.write(p.dependency);
        try js.write(p.weight);
        try js.endArray();
    }
    try js.endArray();

    var pseudo: std.ArrayList([]const u8) = .empty;
    for (obs.headers) |h| if (h.name.len > 0 and h.name[0] == ':') try pseudo.append(arena, h.name);
    try js.objectField("pseudo_header_order");
    try js.write(pseudo.items);
    try js.objectField("headers_stream_id");
    try js.write(obs.headers_stream_id);
    if (obs.hpack_error) |e| {
        try js.objectField("hpack_error");
        try js.write(e);
    }
    const s = try akamai.format(arena, .{ .settings = obs.settings, .window_update = obs.window_update, .priorities = obs.priorities, .pseudo_headers = pseudo.items });
    try js.objectField("akamai");
    try js.write(s);
    try js.endObject();
}

/// "http" object: header names in order, allow-listed values, and the UA / client-hint consistency findings.
pub fn http(arena: std.mem.Allocator, js: *Json, headers: []const hpack.Header) !void {
    try js.beginObject();
    try js.objectField("header_count");
    try js.write(headers.len);
    try js.objectField("headers_order");
    try js.beginArray();
    for (headers) |h| try js.write(h.name);
    try js.endArray();
    try js.objectField("headers");
    try js.beginArray();
    for (headers) |h| {
        try js.beginObject();
        try js.objectField("name");
        try js.write(h.name);
        if ((h.name.len > 0 and h.name[0] == ':') or isPrintableValueHeader(h.name)) {
            try js.objectField("value");
            try js.write(h.value);
        }
        try js.endObject();
    }
    try js.endArray();
    const ua = findHeader(headers, "user-agent");
    try js.objectField("user_agent");
    try js.write(ua);
    try js.objectField("sec_ch_ua");
    try js.write(findHeader(headers, "sec-ch-ua"));
    try js.objectField("sec_ch_ua_platform");
    try js.write(findHeader(headers, "sec-ch-ua-platform"));
    try js.objectField("accept_language");
    try js.write(findHeader(headers, "accept-language"));

    var findings: std.ArrayList(check_headers.Finding) = .empty;
    try check_headers.uaVersusClientHints(arena, ua, findHeader(headers, "sec-ch-ua"), findHeader(headers, "sec-ch-ua-platform"), &findings);
    try js.objectField("checks");
    try js.beginArray();
    for (findings.items) |f| {
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
    try js.endObject();
}

test "collectH2 on the real Chrome stream yields four settings and a decoded request" {
    const fixtures = @import("fixtures");
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const after = try frame.stripPreface(fixtures.h2.chrome_153_macos);
    const obs = try collectH2(arena, after);
    try std.testing.expectEqual(@as(usize, 4), obs.settings.len);
    try std.testing.expectEqual(@as(usize, 3), obs.frame_headers.len);
    try std.testing.expect(obs.headers.len > 4);
    try std.testing.expectEqualStrings(":method", obs.headers[0].name);
    try std.testing.expect(obs.hpack_error == null and obs.frame_error == null);
    // Render the http2/http objects into a buffer to make sure the writers do not error on real data.
    var buf: [16384]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    var js: Json = .{ .writer = &w };
    try js.beginObject();
    try js.objectField("http2");
    try http2(arena, &js, obs);
    try js.objectField("http");
    try http(arena, &js, obs.headers);
    try js.endObject();
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "\"akamai\":\"1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p\"") != null);
}
