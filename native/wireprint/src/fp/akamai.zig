//! Akamai HTTP/2 client fingerprint ("Passive Fingerprinting of HTTP/2 Clients", Black Hat EU 2017,
//! https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf).
//! Format: S[;]|WU|P[,]|PS[,]
//!   S  = SETTINGS "id:value" pairs in wire order joined by ';'
//!   WU = connection-level WINDOW_UPDATE increment, "00" if none before the first HEADERS
//!   P  = PRIORITY frames "streamID:exclusive:dependency:weight" joined by ',' ("0" if none); weight = byte + 1
//!   PS = pseudo-header order letters m/p/a/s joined by ','
//! Scope (project decision, whitepaper leaves it open): frames after the preface up to
//! and including the first HEADERS (+CONTINUATION); only stream-0 WINDOW_UPDATE counts; a PRIORITY flag
//! inside HEADERS does not go into P.
//! Oracle: whitepaper page 9 example signatures (format only) and fixtures/h2/*.bin whose SETTINGS values
//! match Chromium net/http/http_network_session.cc defaults.
//! Reproduce: `zig build test`; the whitepaper string is quoted verbatim in the first test.
//!
//! This file only *formats* an Observation. Collecting one from a connection (applying the scope rule
//! above) is the connection layer's job (server/h2_conn.zig); the Chrome test below does it by hand.
//! Numbers are decimal, as in every whitepaper example ("1:65536"), not the 4-digit hex used elsewhere.
const std = @import("std");

pub const Setting = struct { id: u16, value: u32 };
/// `weight` is the octet as sent on the wire (0..255); the string shows `weight + 1` (1..256).
pub const PriorityRecord = struct { stream_id: u31, exclusive: bool, dependency: u31, weight: u8 };

pub const Observation = struct {
    settings: []const Setting,
    window_update: ?u32,
    priorities: []const PriorityRecord,
    /// Pseudo-header names in the order they appear in the first request, e.g. ":method", ":path"...
    pseudo_headers: []const []const u8,
};

/// Whitepaper p.8: "m (:method) p (:path) a (:authority) s (:scheme)". Other pseudo-headers (e.g.
/// ":protocol" from RFC 8441, or response-only ":status") have no letter and are skipped.
pub fn pseudoHeaderLetter(name: []const u8) ?u8 {
    const map = [_]struct { name: []const u8, letter: u8 }{
        .{ .name = ":method", .letter = 'm' },
        .{ .name = ":path", .letter = 'p' },
        .{ .name = ":authority", .letter = 'a' },
        .{ .name = ":scheme", .letter = 's' },
    };
    for (map) |m| {
        if (std.mem.eql(u8, m.name, name)) return m.letter;
    }
    return null;
}

/// Caller owns the returned string (free with `gpa`).
pub fn format(gpa: std.mem.Allocator, obs: Observation) std.mem.Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);

    // S — "Key:Value. Multiple settings are concatenated using a semicolon (;) according to the order of
    // their appearance." (p.5). An empty SETTINGS frame gives an empty segment (not defined by the paper).
    for (obs.settings, 0..) |s, i| {
        if (i > 0) try out.append(gpa, ';');
        try out.print(gpa, "{d}:{d}", .{ s.id, s.value });
    }
    try out.append(gpa, '|');

    // WU — "WINDOW_UPDATE increment size — '00' if the frame is not present" (p.5).
    if (obs.window_update) |wu| {
        try out.print(gpa, "{d}", .{wu});
    } else {
        try out.appendSlice(gpa, "00");
    }
    try out.append(gpa, '|');

    // P — "StreamID:Exclusivity_Bit:Dependant_StreamID:Weight ... concatenated by a comma (,). If this
    // feature does not exist, the value should be '0'." (p.5). Weight "values are between 1 and 256"
    // (p.4), i.e. octet + 1 (RFC 7540 §6.3 "Add one to the value to obtain a weight between 1 and 256").
    if (obs.priorities.len == 0) {
        try out.append(gpa, '0');
    } else {
        for (obs.priorities, 0..) |p, i| {
            if (i > 0) try out.append(gpa, ',');
            try out.print(gpa, "{d}:{d}:{d}:{d}", .{ p.stream_id, @intFromBool(p.exclusive), p.dependency, @as(u16, p.weight) + 1 });
        }
    }
    try out.append(gpa, '|');

    // PS — letters in the order the pseudo-headers appeared, comma-joined (p.8 example "m,p,a,s").
    var first = true;
    for (obs.pseudo_headers) |name| {
        const letter = pseudoHeaderLetter(name) orelse continue;
        if (!first) try out.append(gpa, ',');
        try out.append(gpa, letter);
        first = false;
    }

    return out.toOwnedSlice(gpa);
}

// ---------------------------------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const fixtures = @import("fixtures");
const frame = @import("../h2/frame.zig");
const hpack = @import("../h2/hpack.zig");

test "format: whitepaper p.9 Firefox 53 example, verbatim" {
    // Wire weight octets are the printed weights minus one (201 -> 200, ...).
    const obs: Observation = .{
        .settings = &.{
            .{ .id = 1, .value = 65536 },
            .{ .id = 4, .value = 131072 },
            .{ .id = 5, .value = 16384 },
        },
        .window_update = 12517377,
        .priorities = &.{
            .{ .stream_id = 3, .exclusive = false, .dependency = 0, .weight = 200 },
            .{ .stream_id = 5, .exclusive = false, .dependency = 0, .weight = 100 },
            .{ .stream_id = 7, .exclusive = false, .dependency = 0, .weight = 0 },
            .{ .stream_id = 9, .exclusive = false, .dependency = 7, .weight = 0 },
            .{ .stream_id = 11, .exclusive = false, .dependency = 3, .weight = 0 },
        },
        .pseudo_headers = &.{ ":method", ":path", ":authority", ":scheme" },
    };
    const s = try format(testing.allocator, obs);
    defer testing.allocator.free(s);
    try testing.expectEqualStrings(
        "1:65536;4:131072;5:16384|12517377|3:0:0:201,5:0:0:101,7:0:0:1,9:0:7:1,11:0:3:1|m,p,a,s",
        s,
    );
}

test "format: absent WINDOW_UPDATE is 00, absent PRIORITY is 0, weight 255 prints 256, unknown pseudo-headers skipped" {
    // S and WU shapes of whitepaper p.6 Example 9 (nghttp2: "3:100;4:65535|00|..."); weight 255 is the
    // octet Chrome puts in its HEADERS priority fields, used here only to exercise the +1 at the top end.
    const obs: Observation = .{
        .settings = &.{ .{ .id = 3, .value = 100 }, .{ .id = 4, .value = 65535 } },
        .window_update = null,
        .priorities = &.{},
        .pseudo_headers = &.{ ":method", ":protocol", ":scheme", ":authority", ":path" },
    };
    const s = try format(testing.allocator, obs);
    defer testing.allocator.free(s);
    try testing.expectEqualStrings("3:100;4:65535|00|0|m,s,a,p", s);

    const top = try format(testing.allocator, .{
        .settings = &.{},
        .window_update = 1,
        .priorities = &.{.{ .stream_id = 1, .exclusive = true, .dependency = 0, .weight = 255 }},
        .pseudo_headers = &.{},
    });
    defer testing.allocator.free(top);
    try testing.expectEqualStrings("|1|1:1:0:256|", top);
}

const Observed = struct { obs: Observation, headers: []const hpack.Header };

/// Test-only collector applying the scope rule from the module comment to a decrypted client stream.
/// Everything is allocated in `arena`; the HPACK decoder's table uses `gpa` and is freed before return.
fn observeFirstRequest(arena: std.mem.Allocator, gpa: std.mem.Allocator, stream: []const u8) !Observed {
    var settings_list: std.ArrayList(Setting) = .empty;
    var priorities: std.ArrayList(PriorityRecord) = .empty;
    var window_update: ?u32 = null;
    var block: std.ArrayList(u8) = .empty;
    var complete = false;

    var it: frame.FrameIterator = .{ .bytes = try frame.stripPreface(stream) };
    frames: while (try it.next()) |f| {
        switch (@as(frame.FrameType, @enumFromInt(f.header.type))) {
            .settings => {
                var si = try frame.settings(f); // an ACK yields nothing
                while (si.next()) |s| try settings_list.append(arena, .{ .id = s.id, .value = s.value });
            },
            .window_update => if (f.header.stream_id == 0 and window_update == null) {
                window_update = try frame.windowUpdate(f);
            },
            .priority => {
                const p = try frame.priority(f);
                try priorities.append(arena, .{ .stream_id = f.header.stream_id, .exclusive = p.exclusive, .dependency = p.dependency, .weight = p.weight });
            },
            .headers => {
                const h = try frame.headers(f); // h.priority deliberately ignored (scope rule)
                try block.appendSlice(arena, h.fragment);
                if (h.end_headers) {
                    complete = true;
                    break :frames;
                }
            },
            .continuation => {
                try block.appendSlice(arena, try frame.continuation(f));
                if (f.header.flags & frame.Flags.end_headers != 0) {
                    complete = true;
                    break :frames;
                }
            },
            else => {},
        }
    }
    if (!complete) return error.TestUnexpectedResult;

    var decoder = hpack.Decoder.init(gpa, 4096);
    defer decoder.deinit();
    var list: std.ArrayList(hpack.Header) = .empty;
    try decoder.decodeBlock(block.items, arena, &list);

    var pseudo: std.ArrayList([]const u8) = .empty;
    for (list.items) |h| {
        if (h.name.len > 0 and h.name[0] == ':') try pseudo.append(arena, h.name);
    }
    return .{
        .obs = .{ .settings = settings_list.items, .window_update = window_update, .priorities = priorities.items, .pseudo_headers = pseudo.items },
        .headers = list.items,
    };
}

/// Expected PS computed from the decoded header list independently of `pseudoHeaderLetter`: the letter
/// is the first character after ':' for the four request pseudo-headers.
fn expectedPs(arena: std.mem.Allocator, list: []const hpack.Header) ![]const u8 {
    var ps: std.ArrayList(u8) = .empty;
    for (list) |h| {
        if (h.name.len < 2 or h.name[0] != ':') continue;
        const request_pseudo = std.mem.eql(u8, h.name, ":method") or std.mem.eql(u8, h.name, ":path") or
            std.mem.eql(u8, h.name, ":authority") or std.mem.eql(u8, h.name, ":scheme");
        if (!request_pseudo) continue;
        if (ps.items.len > 0) try ps.append(arena, ',');
        try ps.append(arena, h.name[1]);
    }
    return ps.items;
}

test "format: Chrome 153 real stream (fixtures/h2)" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const seen = try observeFirstRequest(arena, testing.allocator, fixtures.h2.chrome_153_macos);

    try testing.expectEqual(@as(usize, 4), seen.obs.settings.len);
    try testing.expectEqual(@as(usize, 0), seen.obs.priorities.len); // HEADERS' own priority is not P
    const ps = try expectedPs(arena, seen.headers);
    try testing.expectEqual(@as(usize, 7), ps.len); // four letters, three commas

    // S and WU from Chromium 153 source (see h2/frame.zig tests): ids ascending 1,2,4,6 with
    // 64 KiB / 0 / 6 MiB / 256 KiB; WU = 15 MiB - 65535.
    const want = try std.fmt.allocPrint(arena, "1:65536;2:0;4:6291456;6:262144|{d}|0|{s}", .{ 15 * 1024 * 1024 - 65535, ps });
    const got = try format(testing.allocator, seen.obs);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(want, got);
}

test "format: Safari 26.6.2 real stream (fixtures/h2) — SETTINGS ACK before HEADERS adds nothing" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const seen = try observeFirstRequest(arena, testing.allocator, fixtures.h2.safari_26_6_2_macos);

    // 24-octet SETTINGS = 4 settings; the empty ACK frame contributes none.
    try testing.expectEqual(@as(usize, 4), seen.obs.settings.len);
    try testing.expect(seen.obs.window_update != null);
    const got = try format(testing.allocator, seen.obs);
    defer testing.allocator.free(got);

    var segments = std.mem.splitScalar(u8, got, '|');
    const s_seg = segments.next() orelse return error.TestUnexpectedResult;
    _ = segments.next() orelse return error.TestUnexpectedResult; // WU (observed value, no oracle)
    const p_seg = segments.next() orelse return error.TestUnexpectedResult;
    const ps_seg = segments.next() orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(?[]const u8, null), segments.next());
    try testing.expectEqual(@as(usize, 3), std.mem.count(u8, s_seg, ";"));
    try testing.expectEqualStrings("0", p_seg);
    try testing.expectEqualStrings(try expectedPs(arena, seen.headers), ps_seg);
}
