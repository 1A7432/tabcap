//! JA4 TLS client fingerprint (FoxIO, BSD-3-Clause).
//!
//! Spec: https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md (line numbers below refer
//! to commit 16b96d95c220762cf658f67d678cda2aac95c81e). Where implementations disagree the spec text is
//! the final judge, Wireshark core (`packet-tls-utils.c`) second, FoxIO Python/Rust reference only
//! (the author's ruling).
//!
//!   JA4    = a "_" b "_" c
//!   a      = proto(t|q|d) version(2) sni(d|i) cipher count(2) extension count(2) alpn(2)   L22-L29
//!   b      = sha256(sorted cipher hex, "," joined)[0..12]                                   L106-L122
//!   c      = sha256(sorted extension hex minus 0000/0010, "," joined [+ "_" sigalgs])[0..12] L124-L177
//!   JA4_r  = a "_" sorted ciphers "_" sorted extensions [+ "_" sigalgs], not hashed          L197-L206
//!   JA4_o  = as JA4, but ciphers and extensions in wire order and 0000/0010 kept              L208-L220
//!   JA4_ro = the unhashed form of JA4_o
//!
//! Rules as implemented:
//!   - GREASE (RFC 8701) is dropped from every list: ciphers, extensions, supported_versions, signature
//!     algorithms (L40: "ignore GREASE values anywhere it sees them").
//!   - version: numerically highest non-GREASE value of supported_versions (0x002b); without that
//!     extension, or when it holds only GREASE, legacy_version (L58; Wireshark core falls back the same
//!     way). Map (L60-L70): 0304 13, 0303 12, 0302 11, 0301 10, 0300 s3, 0002 s2, feff d1, fefd d2,
//!     fefc d3, anything else 00. For DTLS "highest value" is taken literally (numeric max), like
//!     Wireshark core; the oracles leave the DTLS ordering question open.
//!   - sni: "d" if extension 0x0000 is present, whatever its body; "i" otherwise (L74).
//!   - counts: non-GREASE entries, two digits, "99" above 99. SCSV 0x00ff/0x5600 and 0xfe00-0xfeff are
//!     ordinary ciphers; the extension count includes 0x0000 and 0x0010 (L78, L82).
//!   - alpn: the first ALPN protocol name. "00" if there is no ALPN extension, no protocol name, or the
//!     first name is empty (L93). The last two break RFC 7301, so they are recognised before the strict
//!     decoder would reject them; any other malformed ALPN body is error.Malformed. If the first and the
//!     last byte are both ASCII alphanumeric (0-9 A-Z a-z) they are printed as is (a single byte counts
//!     as both); otherwise the first and last character of the name's hex form are printed, i.e. the high
//!     nibble of the first byte and the low nibble of the last byte (L95-L104).
//!   - c gets "_" + signature algorithms (wire order, GREASE dropped) only when at least one non-GREASE
//!     value remains (L169: "If there are no signature algorithms in the hello packet, then the string
//!     ends without an underscore"); an extension holding only GREASE adds nothing.
//!   - b is "000000000000" when no cipher remains; c is "000000000000" when the extension list is empty
//!     (after dropping 0000/0010 for JA4, after dropping only GREASE for JA4_o) (L121, L176). The raw
//!     forms print the empty list as an empty string.
//!   - Body decoders that JA4 needs (supported_versions, signature_algorithms, ALPN) propagate their
//!     error.Malformed: a self-contradictory ClientHello gets no fingerprint rather than a guessed one.
//!
//! Oracle: spec/test-vectors.json `ja4` block (JA4.md L118, L166, L173, L194, L205, L213, L219; the
//! hashes were recomputed independently) and the ALPN examples of L97-L104.
//! Reproduce: `zig build test`. The vector test encodes the official input lists into a ClientHello,
//! parses it with tls.client_hello.parse and compares JA4 / JA4_r / JA4_o / JA4_ro verbatim. Real
//! browser captures (fixtures/clienthello) are only printed to the test log, for comparison with
//! Wireshark's `tls.handshake.ja4` / `tls.handshake.ja4_r` on the same bytes; they are not oracle values.
const std = @import("std");
const builtin = @import("builtin");
const client_hello = @import("../tls/client_hello.zig");
const ClientHello = client_hello.ClientHello;
const grease = @import("../tls/grease.zig");
const hex = @import("../hex.zig");

const Sha256 = std.crypto.hash.sha2.Sha256;
const ext = client_hello.ext;

pub const Transport = enum { tcp, quic, dtls };

pub const Result = struct {
    ja4: []u8, // "t13d1516h2_8daaf6152771_e5627efa2ab1"
    ja4_r: []u8, // raw: sorted lists instead of hashes
    ja4_o: []u8, // original order, hashed
    ja4_ro: []u8, // original order, raw
    ja4_a: []u8, // first section alone, for convenience

    pub fn deinit(self: *Result, gpa: std.mem.Allocator) void {
        gpa.free(self.ja4);
        gpa.free(self.ja4_r);
        gpa.free(self.ja4_o);
        gpa.free(self.ja4_ro);
        gpa.free(self.ja4_a);
        self.* = undefined;
    }
};

pub const Error = std.mem.Allocator.Error || error{ Truncated, Malformed };

/// Printed instead of a hash when the hashed list is empty (JA4.md L121-L122, L176-L177). It is not the
/// hash of the empty string (that would start e3b0c44298fc).
pub const empty_hash = "000000000000";

pub fn compute(gpa: std.mem.Allocator, ch: *const ClientHello, transport: Transport) Error!Result {
    // Wire-order lists with GREASE removed: the "original" forms.
    const ciphers = try withoutGrease(gpa, ch.cipher_suites);
    defer gpa.free(ciphers);
    const exts = try extensionTypes(gpa, ch);
    defer gpa.free(exts);
    const sigalgs_list = (ch.signatureAlgorithms() catch |err| return decodeError(err)) orelse
        client_hello.U16List{ .bytes = &.{} };
    const sigalgs = try withoutGrease(gpa, sigalgs_list);
    defer gpa.free(sigalgs);

    const a = try sectionA(ch, transport, ciphers.len, exts.len);

    // Sorted forms: every cipher; every extension except SNI and ALPN (L128).
    const sorted_ciphers = try gpa.dupe(u16, ciphers);
    defer gpa.free(sorted_ciphers);
    std.mem.sort(u16, sorted_ciphers, {}, std.sort.asc(u16));
    const sorted_exts_buf = try gpa.alloc(u16, exts.len);
    defer gpa.free(sorted_exts_buf);
    var n_sorted_exts: usize = 0;
    for (exts) |kind| {
        if (kind == ext.server_name or kind == ext.alpn) continue;
        sorted_exts_buf[n_sorted_exts] = kind;
        n_sorted_exts += 1;
    }
    const sorted_exts = sorted_exts_buf[0..n_sorted_exts];
    std.mem.sort(u16, sorted_exts, {}, std.sort.asc(u16));

    const b_raw = try hexList(gpa, sorted_ciphers);
    defer gpa.free(b_raw);
    const c_raw = try extensionSection(gpa, sorted_exts, sigalgs);
    defer gpa.free(c_raw);
    const bo_raw = try hexList(gpa, ciphers);
    defer gpa.free(bo_raw);
    const co_raw = try extensionSection(gpa, exts, sigalgs);
    defer gpa.free(co_raw);

    const b = hashSection(b_raw, sorted_ciphers.len);
    const c = hashSection(c_raw, sorted_exts.len);
    const bo = hashSection(bo_raw, ciphers.len);
    const co = hashSection(co_raw, exts.len);

    const ja4_a = try gpa.dupe(u8, &a);
    errdefer gpa.free(ja4_a);
    const ja4 = try std.fmt.allocPrint(gpa, "{s}_{s}_{s}", .{ &a, &b, &c });
    errdefer gpa.free(ja4);
    const ja4_r = try std.fmt.allocPrint(gpa, "{s}_{s}_{s}", .{ &a, b_raw, c_raw });
    errdefer gpa.free(ja4_r);
    const ja4_o = try std.fmt.allocPrint(gpa, "{s}_{s}_{s}", .{ &a, &bo, &co });
    errdefer gpa.free(ja4_o);
    const ja4_ro = try std.fmt.allocPrint(gpa, "{s}_{s}_{s}", .{ &a, bo_raw, co_raw });

    return .{ .ja4 = ja4, .ja4_r = ja4_r, .ja4_o = ja4_o, .ja4_ro = ja4_ro, .ja4_a = ja4_a };
}

/// The decoders share client_hello.ParseError; NotClientHello cannot come out of an extension body, but
/// the error set says it could, so it is folded into Malformed.
fn decodeError(err: client_hello.ParseError) Error {
    return switch (err) {
        error.Truncated => error.Truncated,
        error.Malformed, error.NotClientHello => error.Malformed,
    };
}

/// Owned copy of `list` without GREASE values, wire order kept.
fn withoutGrease(gpa: std.mem.Allocator, list: client_hello.U16List) Error![]u16 {
    var out: std.ArrayList(u16) = .empty;
    errdefer out.deinit(gpa);
    try out.ensureTotalCapacityPrecise(gpa, list.len());
    for (0..list.len()) |i| {
        const v = list.at(i);
        if (!grease.isGrease(v)) out.appendAssumeCapacity(v);
    }
    return out.toOwnedSlice(gpa);
}

/// Owned list of extension types in wire order without GREASE (0x0000 and 0x0010 included).
fn extensionTypes(gpa: std.mem.Allocator, ch: *const ClientHello) Error![]u16 {
    var out: std.ArrayList(u16) = .empty;
    errdefer out.deinit(gpa);
    // extension_count is only a capacity hint: a ClientHello assembled by hand may disagree with its block.
    try out.ensureTotalCapacityPrecise(gpa, ch.extension_count);
    var it = ch.iterateExtensions();
    while (it.next() catch |err| return decodeError(err)) |x| {
        if (!grease.isGrease(x.kind)) try out.append(gpa, x.kind);
    }
    return out.toOwnedSlice(gpa);
}

fn sectionA(ch: *const ClientHello, transport: Transport, n_ciphers: usize, n_exts: usize) Error![10]u8 {
    var a: [10]u8 = undefined;
    a[0] = switch (transport) {
        .tcp => 't',
        .quic => 'q',
        .dtls => 'd',
    };
    a[1..3].* = versionCode(try version(ch));
    a[3] = if (ch.findExtension(ext.server_name) != null) 'd' else 'i';
    a[4..6].* = count2(n_ciphers);
    a[6..8].* = count2(n_exts);
    a[8..10].* = try alpnCode(ch);
    return a;
}

/// Highest non-GREASE supported_versions value, else legacy_version (JA4.md L58).
fn version(ch: *const ClientHello) Error!u16 {
    const list = (ch.supportedVersions() catch |err| return decodeError(err)) orelse return ch.legacy_version;
    var highest: ?u16 = null;
    for (0..list.len()) |i| {
        const v = list.at(i);
        if (grease.isGrease(v)) continue;
        if (highest == null or v > highest.?) highest = v;
    }
    return highest orelse ch.legacy_version;
}

/// JA4.md L60-L70.
fn versionCode(v: u16) [2]u8 {
    return switch (v) {
        0x0304 => "13".*,
        0x0303 => "12".*,
        0x0302 => "11".*,
        0x0301 => "10".*,
        0x0300 => "s3".*,
        0x0002 => "s2".*,
        0xfeff => "d1".*,
        0xfefd => "d2".*,
        0xfefc => "d3".*,
        else => "00".*,
    };
}

/// Two decimal digits, "99" for anything above 99 (JA4.md L78).
fn count2(n: usize) [2]u8 {
    const c: u8 = @intCast(@min(n, 99));
    return .{ '0' + c / 10, '0' + c % 10 };
}

/// JA4.md L86-L104.
fn alpnCode(ch: *const ClientHello) Error![2]u8 {
    const body = ch.findExtension(ext.alpn) orelse return "00".*;
    const names = ch.alpn() catch |err| {
        if (alpnHasNoFirstName(body)) return "00".*;
        return decodeError(err);
    };
    var it = names orelse return "00".*;
    const first = (it.next() catch |err| return decodeError(err)) orelse return "00".*;
    return alpnChars(first);
}

/// The L93 "00" cases that RFC 7301 forbids (so the strict decoder rejects them): an empty extension
/// body, an empty protocol_name_list, or a first ProtocolName of length zero.
fn alpnHasNoFirstName(body: []const u8) bool {
    if (body.len == 0) return true;
    if (body.len < 2) return false;
    if (std.mem.readInt(u16, body[0..2], .big) == 0) return true;
    return body.len >= 3 and body[2] == 0;
}

/// First/last character rule for one ALPN protocol name (JA4.md L86, L93, L95-L104).
fn alpnChars(name: []const u8) [2]u8 {
    if (name.len == 0) return "00".*;
    const first = name[0];
    const last = name[name.len - 1];
    if (std.ascii.isAlphanumeric(first) and std.ascii.isAlphanumeric(last)) return .{ first, last };
    // First and last character of the hex representation of the whole name.
    return .{ hex.digits[first >> 4], hex.digits[last & 0x0f] };
}

/// "0005,000a,..." (4 lowercase hex digits per value, comma separated). Owned.
fn hexList(gpa: std.mem.Allocator, values: []const u16) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try appendHexList(gpa, &out, values);
    return out.toOwnedSlice(gpa);
}

fn appendHexList(gpa: std.mem.Allocator, out: *std.ArrayList(u8), values: []const u16) Error!void {
    try out.ensureUnusedCapacity(gpa, values.len * 5);
    for (values, 0..) |v, i| {
        if (i > 0) out.appendAssumeCapacity(',');
        out.appendSliceAssumeCapacity(&hex.u16Hex(v));
    }
}

/// Extension list, then "_" and the signature algorithms only if there are any (JA4.md L144, L169).
fn extensionSection(gpa: std.mem.Allocator, exts: []const u16, sigalgs: []const u16) Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try appendHexList(gpa, &out, exts);
    if (sigalgs.len > 0) {
        try out.append(gpa, '_');
        try appendHexList(gpa, &out, sigalgs);
    }
    return out.toOwnedSlice(gpa);
}

/// First 12 lowercase hex characters (6 bytes) of sha256(raw), or `empty_hash` for an empty list.
fn hashSection(raw: []const u8, list_len: usize) [12]u8 {
    if (list_len == 0) return empty_hash.*;
    var digest: [Sha256.digest_length]u8 = undefined;
    Sha256.hash(raw, &digest, .{});
    var out: [12]u8 = undefined;
    _ = hex.encode(&out, digest[0..6]);
    return out;
}

/// Test-only ClientHello encoder (not product code), shared with the JA3 tests. It writes whatever it
/// is given, so tests can build messages that the parser accepts but that break RFC rules on purpose.
pub const testing_hello = if (builtin.is_test) struct {
    pub const Ext = struct { kind: u16, data: []const u8 = &.{} };

    pub const Hello = struct {
        legacy_version: u16 = 0x0303,
        suites: []const u16,
        /// null: the message ends after compression_methods (no extensions field at all).
        exts: ?[]const Ext = &.{},
    };

    /// Handshake message: type 1, uint24 length, ClientHello body (RFC 8446 §4.1.2 / 9846 §4.2.2).
    pub fn build(gpa: std.mem.Allocator, h: Hello) ![]u8 {
        var body: std.ArrayList(u8) = .empty;
        defer body.deinit(gpa);
        try putU16(gpa, &body, h.legacy_version);
        try body.appendSlice(gpa, &([_]u8{0x11} ** 32)); // random
        try body.append(gpa, 32); // legacy_session_id<0..32>
        try body.appendSlice(gpa, &([_]u8{0x22} ** 32));
        try putU16(gpa, &body, @intCast(h.suites.len * 2)); // cipher_suites<2..2^16-2>
        for (h.suites) |s| try putU16(gpa, &body, s);
        try body.appendSlice(gpa, &.{ 1, 0 }); // legacy_compression_methods = [null]
        if (h.exts) |exts| {
            var len: usize = 0;
            for (exts) |x| len += 4 + x.data.len;
            try putU16(gpa, &body, @intCast(len));
            for (exts) |x| {
                try putU16(gpa, &body, x.kind);
                try putU16(gpa, &body, @intCast(x.data.len));
                try body.appendSlice(gpa, x.data);
            }
        }
        const out = try gpa.alloc(u8, 4 + body.items.len);
        out[0] = client_hello.handshake_type_client_hello;
        std.mem.writeInt(u24, out[1..4], @intCast(body.items.len), .big);
        @memcpy(out[4..], body.items);
        return out;
    }

    /// server_name body with one host_name entry (RFC 6066 §3).
    pub fn sni(gpa: std.mem.Allocator, host: []const u8) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        try putU16(gpa, &out, @intCast(3 + host.len));
        try out.append(gpa, 0); // host_name
        try putU16(gpa, &out, @intCast(host.len));
        try out.appendSlice(gpa, host);
        return out.toOwnedSlice(gpa);
    }

    /// ALPN body (RFC 7301 §3.1): u16 list length, then u8-length-prefixed names.
    pub fn alpn(gpa: std.mem.Allocator, names: []const []const u8) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        var len: usize = 0;
        for (names) |n| len += 1 + n.len;
        try putU16(gpa, &out, @intCast(len));
        for (names) |n| {
            try out.append(gpa, @intCast(n.len));
            try out.appendSlice(gpa, n);
        }
        return out.toOwnedSlice(gpa);
    }

    /// u16 list behind a 1-byte length prefix (supported_versions).
    pub fn u16s8(gpa: std.mem.Allocator, values: []const u16) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        try out.append(gpa, @intCast(values.len * 2));
        for (values) |v| try putU16(gpa, &out, v);
        return out.toOwnedSlice(gpa);
    }

    /// u16 list behind a 2-byte length prefix (signature_algorithms, supported_groups).
    pub fn u16s16(gpa: std.mem.Allocator, values: []const u16) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        try putU16(gpa, &out, @intCast(values.len * 2));
        for (values) |v| try putU16(gpa, &out, v);
        return out.toOwnedSlice(gpa);
    }

    /// u8 list behind a 1-byte length prefix (ec_point_formats).
    pub fn u8s8(gpa: std.mem.Allocator, values: []const u8) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        try out.append(gpa, @intCast(values.len));
        try out.appendSlice(gpa, values);
        return out.toOwnedSlice(gpa);
    }

    fn putU16(gpa: std.mem.Allocator, out: *std.ArrayList(u8), v: u16) !void {
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, v, .big);
        try out.appendSlice(gpa, &b);
    }
} else struct {};

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const spec = @import("spec");
const fixtures = @import("fixtures");
const record = @import("../tls/record.zig");
const th = testing_hello;

fn jsonGet(v: std.json.Value, key: []const u8) !std.json.Value {
    if (v != .object) return error.TestUnexpectedJson;
    return v.object.get(key) orelse error.TestUnexpectedJson;
}

fn jsonStr(v: std.json.Value, key: []const u8) ![]const u8 {
    const s = try jsonGet(v, key);
    if (s != .string) return error.TestUnexpectedJson;
    return s.string;
}

fn jsonHexList(arena: std.mem.Allocator, v: std.json.Value, key: []const u8) ![]u16 {
    const arr = try jsonGet(v, key);
    if (arr != .array) return error.TestUnexpectedJson;
    const out = try arena.alloc(u16, arr.array.items.len);
    for (arr.array.items, out) |item, *o| {
        if (item != .string) return error.TestUnexpectedJson;
        o.* = try std.fmt.parseInt(u16, item.string, 16);
    }
    return out;
}

/// The official JA4.md example as spec/test-vectors.json records it.
const Official = struct {
    ciphers: []u16,
    exts: []u16,
    sigalgs: []u16,
    expected: std.json.Value,
    ja4: std.json.Value, // the whole `ja4` block

    fn load(arena: std.mem.Allocator) !Official {
        const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, spec.test_vectors_json, .{});
        const ja4 = try jsonGet(root, "ja4");
        const example = try jsonGet(ja4, "official_example");
        const input = try jsonGet(example, "input");
        return .{
            .ciphers = try jsonHexList(arena, input, "cipher_suites_original"),
            .exts = try jsonHexList(arena, input, "extensions_original"),
            .sigalgs = try jsonHexList(arena, input, "signature_algorithms_original"),
            .expected = try jsonGet(example, "expected"),
            .ja4 = ja4,
        };
    }

    /// Section `i` (0-based, "_" separated) of an expected string.
    fn part(o: Official, key: []const u8, i: usize) ![]const u8 {
        var it = std.mem.splitScalar(u8, try jsonStr(o.expected, key), '_');
        var n: usize = 0;
        while (it.next()) |p| : (n += 1) {
            if (n == i) return p;
        }
        return error.TestUnexpectedJson;
    }
};

const h2_alpn_body = [_]u8{ 0x00, 0x03, 0x02, 'h', '2' };

/// Changes applied while encoding the official example.
const Tweaks = struct {
    legacy_version: u16 = 0x0303,
    /// Body of the ALPN extension; null drops the extension.
    alpn_body: ?[]const u8 = &h2_alpn_body,
    /// Body of the SNI extension; null uses a host_name entry.
    sni_body: ?[]const u8 = null,
    /// supported_versions values (JA4.md example: TLS 1.3 with 1.2 fallback).
    versions: []const u16 = &.{ 0x0304, 0x0303 },
    /// Replaces the vector's signature algorithms.
    sigalgs: ?[]const u16 = null,
    /// Extension types to leave out.
    drop: []const u16 = &.{},
    /// Sprinkle RFC 8701 values into ciphers, extensions, supported_versions and sigalgs.
    grease: bool = false,
};

/// Encodes the official example (with `t`) as a ClientHello handshake message.
fn officialHello(arena: std.mem.Allocator, o: Official, t: Tweaks) ![]u8 {
    var suites: std.ArrayList(u16) = .empty;
    if (t.grease) try suites.append(arena, 0x0a0a);
    for (o.ciphers, 0..) |c, i| {
        if (t.grease and i == 7) try suites.append(arena, 0xfafa);
        try suites.append(arena, c);
    }

    var sigalgs: std.ArrayList(u16) = .empty;
    if (t.grease) try sigalgs.append(arena, 0x4a4a);
    for (t.sigalgs orelse o.sigalgs, 0..) |s, i| {
        if (t.grease and i == 3) try sigalgs.append(arena, 0x5a5a);
        try sigalgs.append(arena, s);
    }

    var versions: std.ArrayList(u16) = .empty;
    if (t.grease) try versions.append(arena, 0x3a3a);
    try versions.appendSlice(arena, t.versions);

    var exts: std.ArrayList(th.Ext) = .empty;
    if (t.grease) try exts.append(arena, .{ .kind = 0x1a1a });
    for (o.exts) |kind| {
        if (std.mem.indexOfScalar(u16, t.drop, kind) != null) continue;
        const data: []const u8 = switch (kind) {
            ext.server_name => t.sni_body orelse try th.sni(arena, "example.com"),
            ext.alpn => t.alpn_body orelse continue,
            ext.supported_versions => try th.u16s8(arena, versions.items),
            ext.signature_algorithms => try th.u16s16(arena, sigalgs.items),
            else => &.{},
        };
        try exts.append(arena, .{ .kind = kind, .data = data });
    }
    if (t.grease) try exts.append(arena, .{ .kind = 0x2a2a, .data = &.{0} });

    return th.build(arena, .{ .legacy_version = t.legacy_version, .suites = suites.items, .exts = exts.items });
}

fn ja4Of(message: []const u8, transport: Transport) !Result {
    const ch = try client_hello.parse(message);
    return compute(testing.allocator, &ch, transport);
}

fn expectResult(o: Official, r: Result) !void {
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_a"), r.ja4_a);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4"), r.ja4);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_r"), r.ja4_r);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_o"), r.ja4_o);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_ro"), r.ja4_ro);
}

test "official JA4.md example: JA4, JA4_r, JA4_o, JA4_ro match spec/test-vectors.json verbatim" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);

    var r = try ja4Of(try officialHello(arena, o, .{}), .tcp);
    defer r.deinit(testing.allocator);
    try expectResult(o, r);
    // The three sections on their own.
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_b"), r.ja4[11..23]);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_c"), r.ja4[24..36]);
}

test "official example without signature algorithm values: no underscore, c = ja4_c_without_signature_algorithms" {
    // The vector's string (JA4.md L173) still lists 000d: the extension is there, it just carries no
    // (non-GREASE) algorithm. The parser rejects an empty signature_algorithms list, so the only way a real
    // ClientHello reaches L169 is a list holding nothing but GREASE.
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);

    var r = try ja4Of(try officialHello(arena, o, .{ .sigalgs = &.{0x0a0a} }), .tcp);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_c_without_signature_algorithms"), r.ja4[24..36]);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_a"), r.ja4_a);
    try testing.expectEqualStrings(try jsonStr(o.expected, "ja4_b"), r.ja4[11..23]);
    // JA4_r ends with the sorted extension list: exactly two underscores, none after "ff01".
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, r.ja4_r, "_"));
    try testing.expect(std.mem.endsWith(u8, r.ja4_r, "_" ++ "0005,000a,000b,000d,0012,0015,0017,001b,0023,002b,002d,0033,4469,ff01"));
    try testing.expectEqual(@as(usize, 2), std.mem.count(u8, r.ja4_ro, "_"));
}

test "ALPN first/last character rules (test-vectors.json alpn_rules, JA4.md L89-L104)" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);

    const rules = try jsonGet(o.ja4, "alpn_rules");
    if (rules != .array) return error.TestUnexpectedJson;
    try testing.expectEqual(@as(usize, 12), rules.array.items.len);
    for (rules.array.items) |rule| {
        const expected = try jsonStr(rule, "expected");
        const bytes_hex = try jsonGet(rule, "alpn_bytes_hex");
        const body: ?[]const u8 = switch (bytes_hex) {
            .null => null,
            .string => |text| blk: {
                const name = try arena.alloc(u8, text.len / 2);
                _ = try hex.decode(name, text);
                break :blk try th.alpn(arena, &.{name});
            },
            else => return error.TestUnexpectedJson,
        };
        var r = try ja4Of(try officialHello(arena, o, .{ .alpn_body = body }), .tcp);
        defer r.deinit(testing.allocator);
        testing.expectEqualStrings(expected, r.ja4_a[8..10]) catch |err| {
            std.debug.print("alpn rule {s} failed\n", .{if (bytes_hex == .string) bytes_hex.string else "null"});
            return err;
        };
    }
}

test "ALPN: only the first protocol name counts; L93 empty cases print 00; other malformed bodies fail" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);

    const Case = struct { body: []const u8, expected: []const u8 };
    const cases = [_]Case{
        .{ .body = try th.alpn(arena, &.{ "http/1.1", "h2" }), .expected = "h1" },
        .{ .body = try th.alpn(arena, &.{ "h2", "http/1.1" }), .expected = "h2" },
        .{ .body = &.{}, .expected = "00" }, // extension present, empty body: no ALPN values
        .{ .body = &.{ 0x00, 0x00 }, .expected = "00" }, // empty protocol_name_list
        .{ .body = &.{ 0x00, 0x01, 0x00 }, .expected = "00" }, // first ALPN value is empty
        .{ .body = &.{ 0x00, 0x04, 0x00, 0x02, 'h', '2' }, .expected = "00" }, // empty first, then h2
    };
    for (cases) |case| {
        var r = try ja4Of(try officialHello(arena, o, .{ .alpn_body = case.body }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings(case.expected, r.ja4_a[8..10]);
        try testing.expectEqualStrings("16", r.ja4_a[6..8]); // the extension still counts
    }

    // A protocol name running past its list is a contradiction, not "no value".
    const bad = try officialHello(arena, o, .{ .alpn_body = &.{ 0x00, 0x09, 0x02, 'h', '2' } });
    const ch = try client_hello.parse(bad);
    try testing.expectError(error.Malformed, compute(testing.allocator, &ch, .tcp));
}

test "GREASE anywhere changes nothing: JA4 / JA4_r / JA4_o / JA4_ro equal the official vector" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);

    const message = try officialHello(arena, o, .{ .grease = true });
    const ch = try client_hello.parse(message);
    // Sanity: the encoder really put GREASE on the wire.
    try testing.expect(grease.isGrease(ch.cipher_suites.at(0)));
    try testing.expect((try ch.signatureAlgorithms()).?.len() == o.sigalgs.len + 2);
    try testing.expectEqual(o.exts.len + 2, ch.extension_count);

    var r = try compute(testing.allocator, &ch, .tcp);
    defer r.deinit(testing.allocator);
    try expectResult(o, r);
}

test "boundaries: no extensions, no supported_versions, no ALPN, >99 entries, empty lists" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);
    const b = try o.part("ja4", 1);
    const b_o = try o.part("ja4_o", 1);
    const b_r = try o.part("ja4_r", 1);

    // No extensions: neither the field (pre-TLS 1.2 style) nor an empty block. legacy_version decides
    // the version, no SNI, count 00, ALPN 00, c is the empty-list hash (all zeros), raw c is empty.
    for ([_]?[]const th.Ext{ null, &.{} }) |exts| {
        var r = try ja4Of(try th.build(arena, .{ .suites = o.ciphers, .exts = exts }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t12i150000", r.ja4_a);
        try testing.expectEqualStrings(try std.fmt.allocPrint(arena, "t12i150000_{s}_" ++ empty_hash, .{b}), r.ja4);
        try testing.expectEqualStrings(try std.fmt.allocPrint(arena, "t12i150000_{s}_" ++ empty_hash, .{b_o}), r.ja4_o);
        try testing.expectEqualStrings(try std.fmt.allocPrint(arena, "t12i150000_{s}_", .{b_r}), r.ja4_r);
    }

    // No supported_versions: legacy_version is used.
    {
        var r = try ja4Of(try officialHello(arena, o, .{ .legacy_version = 0x0301, .drop = &.{ext.supported_versions} }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t10d1515h2", r.ja4_a);
    }
    // supported_versions holding only GREASE: nothing to take the maximum of, so legacy_version.
    {
        var r = try ja4Of(try officialHello(arena, o, .{ .versions = &.{0x7a7a} }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t12d1516h2", r.ja4_a);
    }
    // Highest value, not first value.
    {
        var r = try ja4Of(try officialHello(arena, o, .{ .versions = &.{ 0x0302, 0x0304, 0x0303 } }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("13", r.ja4_a[1..3]);
    }

    // No ALPN extension: "00", and one extension fewer.
    {
        var r = try ja4Of(try officialHello(arena, o, .{ .alpn_body = null }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t13d151500", r.ja4_a);
        // ALPN is not part of c, so c is unchanged; JA4_o's c includes 0010, so it changes.
        try testing.expectEqualStrings(try o.part("ja4", 2), r.ja4[24..36]);
        try testing.expect(!std.mem.eql(u8, try o.part("ja4_o", 2), r.ja4_o[24..36]));
    }

    // SNI decides by presence alone: an empty server_name body still means "d".
    {
        var r = try ja4Of(try officialHello(arena, o, .{ .sni_body = &.{} }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t13d1516h2", r.ja4_a);
        var r2 = try ja4Of(try officialHello(arena, o, .{ .drop = &.{ext.server_name} }), .tcp);
        defer r2.deinit(testing.allocator);
        try testing.expectEqualStrings("t13i1515h2", r2.ja4_a);
    }

    // More than 99 ciphers / extensions: "99". Exactly 99 is also "99", 9 is "09".
    for ([_]struct { n: usize, text: []const u8 }{ .{ .n = 9, .text = "09" }, .{ .n = 99, .text = "99" }, .{ .n = 100, .text = "99" }, .{ .n = 120, .text = "99" } }) |case| {
        const suites = try arena.alloc(u16, case.n);
        for (suites, 0..) |*s, i| s.* = @intCast(0x0100 + i);
        const exts = try arena.alloc(th.Ext, case.n);
        for (exts, 0..) |*x, i| x.* = .{ .kind = @intCast(0x1000 + i) };
        var r = try ja4Of(try th.build(arena, .{ .suites = suites, .exts = exts }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings(case.text, r.ja4_a[4..6]);
        try testing.expectEqualStrings(case.text, r.ja4_a[6..8]);
    }

    // Only GREASE ciphers: count 00 and b is the all-zero hash (b and b_o alike).
    {
        var r = try ja4Of(try th.build(arena, .{ .suites = &.{ 0x0a0a, 0x1a1a } }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t12i000000_" ++ empty_hash ++ "_" ++ empty_hash, r.ja4);
        try testing.expectEqualStrings("t12i000000_" ++ empty_hash ++ "_" ++ empty_hash, r.ja4_o);
        try testing.expectEqualStrings("t12i000000__", r.ja4_r);
    }

    // Only SNI and ALPN: the sorted list is empty (c all zeros) but JA4_o still hashes "0000,0010".
    {
        const exts = [_]th.Ext{ .{ .kind = ext.server_name, .data = try th.sni(arena, "a.example") }, .{ .kind = ext.alpn, .data = &h2_alpn_body } };
        var r = try ja4Of(try th.build(arena, .{ .suites = &.{0x1301}, .exts = &exts }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings("t12d0102h2", r.ja4_a);
        try testing.expect(std.mem.endsWith(u8, r.ja4, "_" ++ empty_hash));
        try testing.expect(std.mem.endsWith(u8, r.ja4_r, "_1301_"));
        try testing.expect(std.mem.endsWith(u8, r.ja4_ro, "_1301_0000,0010"));
        try testing.expect(!std.mem.endsWith(u8, r.ja4_o, "_" ++ empty_hash));
    }
}

test "SCSV and reserved values count as ciphers (test-vectors.json ja4_counting_rules, JA4.md L78)" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, spec.test_vectors_json, .{});
    const suites = try jsonHexList(arena, try jsonGet(root, "ja4_counting_rules"), "count_as_cipher");

    var r = try ja4Of(try th.build(arena, .{ .suites = suites }), .tcp);
    defer r.deinit(testing.allocator);
    try testing.expectEqualStrings("04", r.ja4_a[4..6]);
    try testing.expectEqualStrings("t12i040000_00ff,5600,fe00,feff_", r.ja4_r);
}

test "version map (test-vectors.json version_map, JA4.md L60-L70) and transport letter" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, spec.test_vectors_json, .{});
    const map = try jsonGet(try jsonGet(root, "ja4"), "version_map");
    if (map != .object) return error.TestUnexpectedJson;

    var it = map.object.iterator();
    var checked: usize = 0;
    while (it.next()) |entry| {
        if (entry.value_ptr.* != .string) return error.TestUnexpectedJson;
        const v: u16 = if (std.mem.eql(u8, entry.key_ptr.*, "unknown")) 0x0305 else try std.fmt.parseInt(u16, entry.key_ptr.*, 16);
        // Once as legacy_version (no supported_versions), once as the only supported_versions value.
        var r = try ja4Of(try th.build(arena, .{ .legacy_version = v, .suites = &.{0x1301} }), .tcp);
        defer r.deinit(testing.allocator);
        try testing.expectEqualStrings(entry.value_ptr.string, r.ja4_a[1..3]);
        const exts = [_]th.Ext{.{ .kind = ext.supported_versions, .data = try th.u16s8(arena, &.{ 0x2a2a, v }) }};
        var r2 = try ja4Of(try th.build(arena, .{ .suites = &.{0x1301}, .exts = &exts }), .tcp);
        defer r2.deinit(testing.allocator);
        try testing.expectEqualStrings(entry.value_ptr.string, r2.ja4_a[1..3]);
        checked += 1;
    }
    try testing.expectEqual(@as(usize, 10), checked);

    const message = try th.build(arena, .{ .suites = &.{0x1301} });
    inline for (.{ .{ Transport.tcp, 't' }, .{ Transport.quic, 'q' }, .{ Transport.dtls, 'd' } }) |pair| {
        var r = try ja4Of(message, pair[0]);
        defer r.deinit(testing.allocator);
        try testing.expectEqual(@as(u8, pair[1]), r.ja4_a[0]);
    }
}

test "malformed extension bodies that JA4 reads are error.Malformed" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const bodies = [_]th.Ext{
        .{ .kind = ext.supported_versions, .data = &.{ 0x03, 0x03, 0x04, 0x03 } }, // odd u16 list
        .{ .kind = ext.supported_versions, .data = &.{} }, // no length byte
        .{ .kind = ext.signature_algorithms, .data = &.{ 0x00, 0x00 } }, // below the <2..> floor
        .{ .kind = ext.signature_algorithms, .data = &.{ 0x00, 0x04, 0x04, 0x03 } }, // runs past the body
        .{ .kind = ext.alpn, .data = &.{0x00} }, // half a length prefix
    };
    for (bodies) |x| {
        const ch = try client_hello.parse(try th.build(arena, .{ .suites = &.{0x1301}, .exts = &.{x} }));
        try testing.expectError(error.Malformed, compute(testing.allocator, &ch, .tcp));
    }
}

fn computeAndFree(gpa: std.mem.Allocator, ch: *const ClientHello) !void {
    var r = try compute(gpa, ch, .tcp);
    r.deinit(gpa);
}

test "every allocation failure is reported as OutOfMemory without leaks" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const o = try Official.load(arena);
    const ch = try client_hello.parse(try officialHello(arena, o, .{ .grease = true }));
    try testing.checkAllAllocationFailures(testing.allocator, computeAndFree, .{&ch});
}

test "real browsers: Chrome's JA4 is stable across connections, JA4_o is not; print all six for Wireshark" {
    // Printed values are for a human to compare with Wireshark `tls.handshake.ja4` / `ja4_r` on the same
    // bytes; they are deliberately not asserted (not oracle values).
    var results: [fixtures.clienthello.all.len]Result = undefined;
    var n: usize = 0;
    defer for (results[0..n]) |*r| r.deinit(testing.allocator);
    for (fixtures.clienthello.all) |f| {
        var scratch: [1]u8 = undefined; // all fixtures are single-record
        const message = (try record.firstHandshakeMessage(f.bytes, &scratch)).bytes;
        results[n] = try ja4Of(message, .tcp);
        n += 1;
        const r = results[n - 1];
        std.debug.print("\n[ja4] {s}\n  JA4    {s}\n  JA4_o  {s}\n  JA4_r  {s}\n  JA4_ro {s}\n", .{ f.name, r.ja4, r.ja4_o, r.ja4_r, r.ja4_ro });
        // All six are TLS 1.3 browsers going to a domain over TCP with h2 first in ALPN.
        try testing.expect(std.mem.startsWith(u8, r.ja4_a, "t13d"));
        try testing.expectEqualStrings("h2", r.ja4_a[8..10]);
        try testing.expect(std.mem.indexOf(u8, r.ja4_r, "_") != null);
    }
    const chrome_1 = results[0];
    const chrome_2 = results[1];
    try testing.expectEqualStrings("chrome-153-macos-1", fixtures.clienthello.all[0].name);
    try testing.expectEqualStrings("chrome-153-macos-2", fixtures.clienthello.all[1].name);
    // Chrome permutes extensions per connection: sorted forms agree, wire-order forms do not.
    try testing.expectEqualStrings(chrome_1.ja4, chrome_2.ja4);
    try testing.expectEqualStrings(chrome_1.ja4_r, chrome_2.ja4_r);
    try testing.expect(!std.mem.eql(u8, chrome_1.ja4_o, chrome_2.ja4_o));
    try testing.expect(!std.mem.eql(u8, chrome_1.ja4_ro, chrome_2.ja4_ro));
    // Only the extension order differs, so the cipher hash is the same in JA4_o.
    try testing.expectEqualStrings(chrome_1.ja4_o[0..23], chrome_2.ja4_o[0..23]);
}
