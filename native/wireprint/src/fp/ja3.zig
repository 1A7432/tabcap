//! JA3 TLS client fingerprint (https://github.com/salesforce/ja3, BSD-3-Clause; README at commit
//! 502cc6395811c54743b0561419d61900a6df3ff7).
//!
//! String: "SSLVersion,Cipher,SSLExtension,EllipticCurve,EllipticCurvePointFormat" (README "How it works")
//!   - all values decimal; '-' between the values of one field, ',' between fields;
//!   - SSLVersion is the ClientHello legacy_version (not supported_versions): 0x0303 -> "771";
//!   - Cipher: cipher_suites in wire order; SSLExtension: extension types in wire order -- including
//!     server_name (0) and ALPN (16), so JA3 does encode whether SNI/ALPN are present;
//!     EllipticCurve: supported_groups (0x000a) list; EllipticCurvePointFormat: ec_point_formats (0x000b)
//!     list (one byte per value);
//!   - GREASE values (RFC 8701) are removed from every u16 list ("JA3 ignores these values completely");
//!   - a missing field is the empty string and its comma stays ("769,4-5-...,,,").
//! Hash: MD5 of the string, 32 lowercase hex characters.
//! Supported_groups / ec_point_formats bodies are decoded with the strict tls.client_hello decoders; a
//! malformed body is error.Malformed (no fingerprint rather than a guessed one).
//!
//! Oracle: the two README examples (string -> MD5):
//!   769,47-53-5-10-49161-49162-49171-49172-50-56-19-4,0-10-11,23-24-25,0 --> ada70206e40642a3e4461f35503241d5
//!   769,4-5-10-9-100-98-3-6-19-18-99,,,                                  --> de350869b8c85de67a350c8d186f11e6
//! Reproduce: `zig build test`. `digest` is checked on both strings; `buildString` is checked by encoding
//! ClientHellos with exactly those fields (plus GREASE that must vanish) and comparing the strings.
//! For real captures, Wireshark's `tls.handshake.ja3_full` / `tls.handshake.ja3` on the same bytes are
//! the comparison; the test log prints ours for that purpose (not asserted).
const std = @import("std");
const client_hello = @import("../tls/client_hello.zig");
const ClientHello = client_hello.ClientHello;
const grease = @import("../tls/grease.zig");
const hex = @import("../hex.zig");

pub const Result = struct {
    /// Owned JA3 string, e.g. "771,4865-4866,0-23-65281,29-23-24,0".
    string: []u8,
    /// Lowercase hex MD5 of `string`.
    hash: [32]u8,

    pub fn deinit(self: *Result, gpa: std.mem.Allocator) void {
        gpa.free(self.string);
        self.* = undefined;
    }
};

pub const Error = std.mem.Allocator.Error || error{ Truncated, Malformed };

pub fn compute(gpa: std.mem.Allocator, ch: *const ClientHello) Error!Result {
    const string = try buildString(gpa, ch);
    return .{ .string = string, .hash = digest(string) };
}

/// The JA3 string for `ch` (owned by the caller).
pub fn buildString(gpa: std.mem.Allocator, ch: *const ClientHello) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);

    // SSLVersion
    try out.print(gpa, "{d},", .{ch.legacy_version});

    // Cipher
    try appendU16s(gpa, &out, ch.cipher_suites);
    try out.append(gpa, ',');

    // SSLExtension (wire order, GREASE removed, 0 and 16 kept)
    var it = ch.iterateExtensions();
    var first = true;
    while (it.next() catch |err| return decodeError(err)) |x| {
        if (grease.isGrease(x.kind)) continue;
        if (!first) try out.append(gpa, '-');
        first = false;
        try out.print(gpa, "{d}", .{x.kind});
    }
    try out.append(gpa, ',');

    // EllipticCurve
    if (ch.supportedGroups() catch |err| return decodeError(err)) |groups| {
        try appendU16s(gpa, &out, groups);
    }
    try out.append(gpa, ',');

    // EllipticCurvePointFormat
    if (ch.ecPointFormats() catch |err| return decodeError(err)) |formats| {
        for (formats, 0..) |f, i| {
            if (i > 0) try out.append(gpa, '-');
            try out.print(gpa, "{d}", .{f});
        }
    }

    return out.toOwnedSlice(gpa);
}

/// Lowercase hex MD5 of a JA3 string.
pub fn digest(string: []const u8) [32]u8 {
    var d: [std.crypto.hash.Md5.digest_length]u8 = undefined;
    std.crypto.hash.Md5.hash(string, &d, .{});
    var out: [32]u8 = undefined;
    _ = hex.encode(&out, &d);
    return out;
}

/// Decimal values of `list` without GREASE, '-' separated.
fn appendU16s(gpa: std.mem.Allocator, out: *std.ArrayList(u8), list: client_hello.U16List) Error!void {
    var first = true;
    for (0..list.len()) |i| {
        const v = list.at(i);
        if (grease.isGrease(v)) continue;
        if (!first) try out.append(gpa, '-');
        first = false;
        try out.print(gpa, "{d}", .{v});
    }
}

/// See ja4.decodeError: NotClientHello cannot come out of an extension body; fold it into Malformed.
fn decodeError(err: client_hello.ParseError) Error {
    return switch (err) {
        error.Truncated => error.Truncated,
        error.Malformed, error.NotClientHello => error.Malformed,
    };
}

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const fixtures = @import("fixtures");
const record = @import("../tls/record.zig");
const th = @import("ja4.zig").testing_hello;
const ext = client_hello.ext;

// salesforce/ja3 README, "How it works" (string --> MD5).
const readme_1 = "769,47-53-5-10-49161-49162-49171-49172-50-56-19-4,0-10-11,23-24-25,0";
const readme_1_md5 = "ada70206e40642a3e4461f35503241d5";
const readme_2 = "769,4-5-10-9-100-98-3-6-19-18-99,,,";
const readme_2_md5 = "de350869b8c85de67a350c8d186f11e6";

test "digest: the two salesforce/ja3 README examples" {
    try testing.expectEqualStrings(readme_1_md5, &digest(readme_1));
    try testing.expectEqualStrings(readme_2_md5, &digest(readme_2));
}

fn ja3Of(message: []const u8) !Result {
    const ch = try client_hello.parse(message);
    return compute(testing.allocator, &ch);
}

test "buildString: a ClientHello with the README example's fields gives the README string and hash" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // 769 = 0x0301; extensions 0 (server_name), 10 (supported_groups 23-24-25), 11 (ec_point_formats 0).
    const suites = [_]u16{ 47, 53, 5, 10, 49161, 49162, 49171, 49172, 50, 56, 19, 4 };
    const exts = [_]th.Ext{
        .{ .kind = ext.server_name, .data = try th.sni(arena, "example.com") },
        .{ .kind = ext.supported_groups, .data = try th.u16s16(arena, &.{ 23, 24, 25 }) },
        .{ .kind = ext.ec_point_formats, .data = try th.u8s8(arena, &.{0}) },
    };
    var r = try ja3Of(try th.build(arena, .{ .legacy_version = 0x0301, .suites = &suites, .exts = &exts }));
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings(readme_1, r.string);
    try testing.expectEqualStrings(readme_1_md5, &r.hash);

    // The same with GREASE in the ciphers, the extensions and the groups: nothing changes.
    const suites_g = [_]u16{ 0x0a0a, 47, 53, 5, 10, 49161, 49162, 0xdada, 49171, 49172, 50, 56, 19, 4 };
    const exts_g = [_]th.Ext{
        .{ .kind = 0x3a3a },
        .{ .kind = ext.server_name, .data = try th.sni(arena, "example.com") },
        .{ .kind = ext.supported_groups, .data = try th.u16s16(arena, &.{ 0x8a8a, 23, 24, 25 }) },
        .{ .kind = 0xeaea, .data = &.{0} },
        .{ .kind = ext.ec_point_formats, .data = try th.u8s8(arena, &.{0}) },
    };
    var rg = try ja3Of(try th.build(arena, .{ .legacy_version = 0x0301, .suites = &suites_g, .exts = &exts_g }));
    defer rg.deinit(testing.allocator);
    try testing.expectEqualStrings(readme_1, rg.string);
    try testing.expectEqualStrings(readme_1_md5, &rg.hash);
}

test "buildString: no extensions gives three empty fields (README second example)" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const suites = [_]u16{ 4, 5, 10, 9, 100, 98, 3, 6, 19, 18, 99 };
    // Both "no extensions field" and "empty extension block".
    for ([_]?[]const th.Ext{ null, &.{} }) |exts| {
        var r = try ja3Of(try th.build(arena, .{ .legacy_version = 0x0301, .suites = &suites, .exts = exts }));
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings(readme_2, r.string);
        try testing.expectEqualStrings(readme_2_md5, &r.hash);
    }
}

test "buildString: wire order kept, 0 and 16 included, missing groups/formats leave empty fields" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const exts = [_]th.Ext{
        .{ .kind = ext.alpn, .data = try th.alpn(arena, &.{"h2"}) },
        .{ .kind = 0x1a1a },
        .{ .kind = ext.extended_master_secret },
        .{ .kind = ext.server_name, .data = try th.sni(arena, "example.com") },
        .{ .kind = ext.renegotiation_info, .data = &.{0} },
    };
    var r = try ja3Of(try th.build(arena, .{ .suites = &.{ 0x1302, 0x1301 }, .exts = &exts }));
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("771,4866-4865,16-23-0-65281,,", r.string);

    // Groups present, formats absent (typical TLS 1.3-only client).
    const exts2 = [_]th.Ext{.{ .kind = ext.supported_groups, .data = try th.u16s16(arena, &.{ 0x11ec, 0x001d }) }};
    var r2 = try ja3Of(try th.build(arena, .{ .suites = &.{0x1301}, .exts = &exts2 }));
    defer r2.deinit(testing.allocator);
    try testing.expectEqualStrings("771,4865,10,4588-29,", r2.string);
}

test "buildString: malformed supported_groups / ec_point_formats bodies are error.Malformed" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const bodies = [_]th.Ext{
        .{ .kind = ext.supported_groups, .data = &.{ 0x00, 0x03, 0x00, 0x17, 0x00 } }, // odd u16 list
        .{ .kind = ext.ec_point_formats, .data = &.{ 0x02, 0x00 } }, // runs past the body
    };
    for (bodies) |x| {
        const ch = try client_hello.parse(try th.build(arena, .{ .suites = &.{0x1301}, .exts = &.{x} }));
        try testing.expectError(error.Malformed, compute(testing.allocator, &ch));
    }
}

fn computeAndFree(gpa: std.mem.Allocator, ch: *const ClientHello) !void {
    var r = try compute(gpa, ch);
    r.deinit(gpa);
}

test "every allocation failure is reported as OutOfMemory without leaks" {
    var scratch: [1]u8 = undefined;
    const message = (try record.firstHandshakeMessage(fixtures.clienthello.chrome_153_macos_1, &scratch)).bytes;
    const ch = try client_hello.parse(message);
    try testing.checkAllAllocationFailures(testing.allocator, computeAndFree, .{&ch});
}

test "real browsers: print JA3 for comparison with Wireshark ja3_full / ja3 (not asserted)" {
    for (fixtures.clienthello.all) |f| {
        var scratch: [1]u8 = undefined; // all fixtures are single-record
        const message = (try record.firstHandshakeMessage(f.bytes, &scratch)).bytes;
        var r = try ja3Of(message);
        defer r.deinit(testing.allocator);
        std.debug.print("\n[ja3] {s}\n  JA3      {s}\n  JA3 md5  {s}\n", .{ f.name, r.string, &r.hash });
        try testing.expect(std.mem.startsWith(u8, r.string, "771,")); // every browser sends legacy 0x0303
        try testing.expectEqual(@as(usize, 4), std.mem.count(u8, r.string, ","));
    }
}
