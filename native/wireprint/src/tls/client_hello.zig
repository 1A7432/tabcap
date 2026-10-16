//! ClientHello parser.
//!
//! Spec: RFC 8446 Section 4.1.2 (https://www.rfc-editor.org/rfc/rfc8446.txt). RFC 9846
//! (https://www.rfc-editor.org/rfc/rfc9846.txt, 2026-07) obsoletes 8446 and renumbers the handshake
//! sections but keeps the wire format; citations below read "8446 §x / 9846 §y". TLS 1.2 ClientHellos
//! (RFC 5246 Section 7.4.1.2) have the same layout, so the parser accepts them too.
//!
//!   struct {
//!       ProtocolVersion legacy_version = 0x0303;    // uint16, 2 bytes, no prefix
//!       Random random;                              // opaque[32]: fixed size, no prefix
//!       opaque legacy_session_id<0..32>;            // 1-byte length prefix
//!       CipherSuite cipher_suites<2..2^16-2>;       // 2-byte length prefix, 2 bytes per suite
//!       opaque legacy_compression_methods<1..2^8-1>;// 1-byte length prefix
//!       Extension extensions<8..2^16-1>;            // 2-byte length prefix (9846: <7..2^16-1>)
//!   } ClientHello;
//!
//!   struct {
//!       ExtensionType extension_type;               // uint16
//!       opaque extension_data<0..2^16-1>;           // 2-byte length prefix
//!   } Extension;
//!
//! Reading the presentation language (8446 §3.4 / 9846 §3.4, "Vectors"):
//!   - `T name[n]` is a fixed-length vector: exactly n bytes, nothing on the wire says how long it is.
//!   - `T name<floor..ceiling>` is variable-length: a length prefix, then the bytes. The prefix is "as many
//!     bytes as required to hold the vector's specified maximum (ceiling) length": ceiling <= 255 -> 1 byte,
//!     <= 65535 -> 2 bytes. So `<0..32>` has a 1-byte prefix and `<2..2^16-2>` a 2-byte prefix.
//!   - The prefix counts BYTES, not elements: "a 17-byte vector of uint16 would be illegal". An odd-length
//!     u16 list is therefore a contradiction, not something to round down.
//!   - Length prefixes and integers are big-endian (network order, §3.3).
//!
//! Error discipline (AGENTS.md):
//!   error.Truncated       the slice given to `parse` is shorter than the 4 + length its handshake header
//!                         announces. This is the ONLY place Truncated comes from: it means "the bytes have
//!                         not all arrived", and more input could fix it.
//!   error.Malformed       a contradiction inside a complete, length-delimited container: an inner length
//!                         running past its outer container, a length outside <floor..ceiling>, an odd u16
//!                         list, an extension block that type/length/data records do not tile exactly,
//!                         a duplicate extension type, bytes left over after a structure, or more bytes
//!                         than the handshake header announced. No amount of extra input can fix these.
//!   error.NotClientHello  msg_type is not 1.
//! No unreachable, @panic or assert is reachable from input bytes.
//!
//! Zero-copy: every slice in the result (and every slice an iterator or decoder returns) points into the
//! `message` given to `parse`. The ClientHello is only valid while that buffer is.
//!
//! Scope: `parse` validates the ClientHello structure and the extension block's framing. It does not
//! interpret extension bodies: unknown extensions (GREASE 0x?a?a, ALPS 0x44cd, ECH 0xfe0d, trust_anchors
//! 0xca34, delegated_credentials 0x0022, record_size_limit 0x001c, padding 0x0015, ...) are opaque bytes.
//! The decoders (`serverName`, `alpn`, ...) each validate one extension's body when called.
//! Semantic rules such as "pre_shared_key MUST be the last extension" (8446 §4.2 / 9846 §4.3) are left to
//! the fingerprint/check layers: a client that breaks them is itself a signal worth recording.
//!
//! Oracle: fixtures/clienthello/*.expected.json, produced by tools/openssl_oracle.c, which feeds the same
//! bytes to OpenSSL 3.6's SSL_CTX_set_client_hello_cb and dumps what OpenSSL parsed: legacy_version,
//! random, session_id, cipher suites (GREASE included, wire order), compression methods, the order of the
//! extensions OpenSSL *recognises*, and the extension_data of each of them. OpenSSL skips unrecognised
//! extensions (GREASE, ALPS, ECH, ...), so the full extension order is checked structurally (the block must
//! tile) and the recognised ones must appear in exactly OpenSSL's order. Reproduce: tools/README-oracle.md,
//! then `zig build test`.
const std = @import("std");

pub const ParseError = error{ Truncated, Malformed, NotClientHello };

pub const handshake_type_client_hello: u8 = 1;

/// Well-known extension type numbers used by the fingerprint layer (IANA tls-extensiontype-values).
pub const ext = struct {
    pub const server_name: u16 = 0x0000;
    pub const status_request: u16 = 0x0005;
    pub const supported_groups: u16 = 0x000a;
    pub const ec_point_formats: u16 = 0x000b;
    pub const signature_algorithms: u16 = 0x000d;
    pub const alpn: u16 = 0x0010;
    pub const signed_certificate_timestamp: u16 = 0x0012;
    pub const padding: u16 = 0x0015;
    pub const extended_master_secret: u16 = 0x0017;
    pub const compress_certificate: u16 = 0x001b;
    pub const session_ticket: u16 = 0x0023;
    pub const pre_shared_key: u16 = 0x0029;
    pub const supported_versions: u16 = 0x002b;
    pub const psk_key_exchange_modes: u16 = 0x002d;
    pub const key_share: u16 = 0x0033;
    pub const application_settings_old: u16 = 0x4469;
    pub const application_settings: u16 = 0x44cd;
    pub const trust_anchors: u16 = 0xca34;
    pub const encrypted_client_hello: u16 = 0xfe0d;
    pub const renegotiation_info: u16 = 0xff01;
};

/// A list of big-endian u16 values stored as raw bytes (even length guaranteed by the parser).
pub const U16List = struct {
    bytes: []const u8,

    pub fn len(self: U16List) usize {
        return self.bytes.len / 2;
    }
    pub fn at(self: U16List, i: usize) u16 {
        return std.mem.readInt(u16, self.bytes[i * 2 ..][0..2], .big);
    }
};

pub const Extension = struct {
    kind: u16,
    data: []const u8,
};

/// Iterates extensions in wire order. `next` returns error.Malformed if the block does not tile, i.e.
/// fewer than 4 bytes remain for a type/length header, or a length runs past the end of the block.
/// After `parse` succeeded, iterating `ClientHello.extensions` cannot fail.
pub const ExtensionIterator = struct {
    bytes: []const u8,
    pos: usize = 0,

    pub fn next(self: *ExtensionIterator) ParseError!?Extension {
        // The block is exhausted exactly at a record boundary: that is what "tiles" means.
        if (self.pos >= self.bytes.len) return null;
        var r: Reader = .{ .bytes = self.bytes, .pos = self.pos };
        // ExtensionType extension_type: uint16, 2 bytes.
        const kind = try r.int(u16);
        // opaque extension_data<0..2^16-1>: 2-byte length prefix, may be empty (e.g. extended_master_secret).
        const data = try r.vector(u16, 0, 0xffff);
        self.pos = r.pos; // advance only after the whole record was read
        return .{ .kind = kind, .data = data };
    }
};

pub const KeyShareEntry = struct {
    group: u16,
    key_exchange: []const u8,
};

/// Iterates KeyShareEntry values (8446 §4.2.8 / 9846 §4.3.8):
///   struct { NamedGroup group; opaque key_exchange<1..2^16-1>; } KeyShareEntry;
/// group is 2 bytes; key_exchange has a 2-byte length prefix and must not be empty.
pub const KeyShareIterator = struct {
    bytes: []const u8,
    pos: usize = 0,

    pub fn next(self: *KeyShareIterator) ParseError!?KeyShareEntry {
        if (self.pos >= self.bytes.len) return null;
        var r: Reader = .{ .bytes = self.bytes, .pos = self.pos };
        const group = try r.int(u16);
        const key_exchange = try r.vector(u16, 1, 0xffff);
        self.pos = r.pos;
        return .{ .group = group, .key_exchange = key_exchange };
    }
};

/// Iterates length-prefixed (1 byte) opaque strings, e.g. ALPN protocol names.
/// Follows RFC 7301 Section 3.1 `opaque ProtocolName<1..2^8-1>`: empty strings are error.Malformed
/// ("Empty strings MUST NOT be included and byte strings MUST NOT be truncated").
pub const OpaqueListIterator = struct {
    bytes: []const u8,
    pos: usize = 0,

    pub fn next(self: *OpaqueListIterator) ParseError!?[]const u8 {
        if (self.pos >= self.bytes.len) return null;
        var r: Reader = .{ .bytes = self.bytes, .pos = self.pos };
        const item = try r.vector(u8, 1, 0xff);
        self.pos = r.pos;
        return item;
    }
};

pub const ClientHello = struct {
    /// The whole handshake message (type + 3-byte length + body) that was parsed.
    message: []const u8,
    legacy_version: u16,
    random: *const [32]u8,
    session_id: []const u8,
    /// Raw cipher_suites list (2 bytes per suite, GREASE included, wire order).
    cipher_suites: U16List,
    compression_methods: []const u8,
    /// Raw extensions block (sequence of type/length/data). Empty if the message has no extensions.
    extensions: []const u8,
    /// Number of extensions (block validated by `parse`).
    extension_count: usize,

    pub fn iterateExtensions(self: *const ClientHello) ExtensionIterator {
        return .{ .bytes = self.extensions };
    }

    /// First extension of the given type, or null. (RFC 8446 forbids duplicates; the parser rejects them
    /// with error.Malformed so "first" is also "only".)
    pub fn findExtension(self: *const ClientHello, kind: u16) ?[]const u8 {
        var it = self.iterateExtensions();
        // `parse` already walked this block, so `next` cannot fail here. A ClientHello assembled by hand
        // around a broken block yields "not found" rather than a crash.
        while (it.next() catch return null) |e| {
            if (e.kind == kind) return e.data;
        }
        return null;
    }

    // ---- decoders for well-known extensions; each validates its own body, borrows from the message ----
    // 8446 §4.2 / 9846 §4.3: "Unless otherwise specified, trailing data is forbidden ... receivers MUST
    // abort the handshake with a "decode_error" alert if there is data left over after parsing the
    // structure." Every decoder therefore ends with `expectEnd`. All failures are error.Malformed: the
    // extension_data is a complete container whose length the extension header already fixed.

    /// host_name entry of server_name (RFC 6066 3), or null if absent.
    ///   enum { host_name(0), (255) } NameType;                         1 byte
    ///   opaque HostName<1..2^16-1>;                                    2-byte prefix, non-empty
    ///   struct { NameType name_type; select (name_type) { case host_name: HostName; } name; } ServerName;
    ///   struct { ServerName server_name_list<1..2^16-1> } ServerNameList;   2-byte prefix, non-empty
    /// Only host_name is defined, so an entry with another name_type has no known length -> Malformed.
    /// "The ServerNameList MUST NOT contain more than one name of the same name_type" -> Malformed.
    pub fn serverName(self: *const ClientHello) ParseError!?[]const u8 {
        const data = self.findExtension(ext.server_name) orelse return null;
        var outer: Reader = .{ .bytes = data };
        const list = try outer.vector(u16, 1, 0xffff);
        try outer.expectEnd();

        var r: Reader = .{ .bytes = list };
        var host: ?[]const u8 = null;
        while (!r.atEnd()) {
            const name_type = try r.int(u8);
            if (name_type != 0) return error.Malformed;
            const name = try r.vector(u16, 1, 0xffff);
            if (host != null) return error.Malformed;
            host = name;
        }
        return host; // non-null: the list is non-empty and every entry is a host_name
    }

    /// ALPN protocol names (RFC 7301) in wire order, or null if absent.
    ///   opaque ProtocolName<1..2^8-1>;                                  1-byte prefix, non-empty
    ///   struct { ProtocolName protocol_name_list<2..2^16-1> } ProtocolNameList;  2-byte prefix
    /// The list is walked once here, so the returned iterator cannot fail.
    pub fn alpn(self: *const ClientHello) ParseError!?OpaqueListIterator {
        const data = self.findExtension(ext.alpn) orelse return null;
        var r: Reader = .{ .bytes = data };
        const list = try r.vector(u16, 2, 0xffff);
        try r.expectEnd();
        var check: OpaqueListIterator = .{ .bytes = list };
        while (try check.next()) |_| {}
        return .{ .bytes = list };
    }

    /// supported_versions (RFC 8446 4.2.1): u8-length-prefixed u16 list, or null.
    ///   ProtocolVersion versions<2..254>;   ceiling 254 fits in one byte -> 1-byte prefix
    /// (9846 §4.3.1.) Values are returned as sent, GREASE included.
    pub fn supportedVersions(self: *const ClientHello) ParseError!?U16List {
        const data = self.findExtension(ext.supported_versions) orelse return null;
        return try u16ListBody(data, u8, 2, 254);
    }
    /// supported_groups (RFC 8446 4.2.7): u16-length-prefixed u16 list, or null.
    ///   NamedGroup named_group_list<2..2^16-1>;   (9846 §4.3.7)
    pub fn supportedGroups(self: *const ClientHello) ParseError!?U16List {
        const data = self.findExtension(ext.supported_groups) orelse return null;
        return try u16ListBody(data, u16, 2, 0xffff);
    }
    /// signature_algorithms (RFC 8446 4.2.3): u16-length-prefixed u16 list, or null.
    ///   SignatureScheme supported_signature_algorithms<2..2^16-2>;   (9846 §4.3.3)
    pub fn signatureAlgorithms(self: *const ClientHello) ParseError!?U16List {
        const data = self.findExtension(ext.signature_algorithms) orelse return null;
        return try u16ListBody(data, u16, 2, 0xfffe);
    }
    /// key_share (RFC 8446 4.2.8) entries, or null.
    ///   struct { KeyShareEntry client_shares<0..2^16-1>; } KeyShareClientHello;   (9846 §4.3.8)
    /// The list may be empty ("This list MAY be empty if the client is requesting a HelloRetryRequest").
    /// The entries are walked once here, so the returned iterator cannot fail.
    pub fn keyShares(self: *const ClientHello) ParseError!?KeyShareIterator {
        const data = self.findExtension(ext.key_share) orelse return null;
        var r: Reader = .{ .bytes = data };
        const list = try r.vector(u16, 0, 0xffff);
        try r.expectEnd();
        var check: KeyShareIterator = .{ .bytes = list };
        while (try check.next()) |_| {}
        return .{ .bytes = list };
    }
    /// ec_point_formats (RFC 8422 5.1.2): u8-length-prefixed u8 list, or null.
    ///   ECPointFormat ec_point_format_list<1..2^8-1>;   1-byte prefix, one byte per format
    pub fn ecPointFormats(self: *const ClientHello) ParseError!?[]const u8 {
        const data = self.findExtension(ext.ec_point_formats) orelse return null;
        var r: Reader = .{ .bytes = data };
        const list = try r.vector(u8, 1, 0xff);
        try r.expectEnd();
        return list;
    }
};

/// Parses a handshake message (`msg[0]` must be 1 = client_hello, followed by the 3-byte body length).
/// `message` must be exactly one handshake message (as returned by `record.firstHandshakeMessage`):
/// fewer bytes than announced is error.Truncated, more is error.Malformed.
pub fn parse(message: []const u8) ParseError!ClientHello {
    // ---- Handshake header (8446 §4 / 9846 §4) ----------------------------------------------------
    //   HandshakeType msg_type;   1 byte, client_hello(1)
    //   uint24 length;            3 bytes, "remaining bytes in message"
    // The type is checked as soon as one byte exists, so a caller can reject other messages early.
    if (message.len < 1) return error.Truncated;
    if (message[0] != handshake_type_client_hello) return error.NotClientHello;
    if (message.len < 4) return error.Truncated;
    const body_len: usize = std.mem.readInt(u24, message[1..4], .big);
    // The outer container. Everything below lives inside these `body_len` bytes, so once they are all
    // present, an inner field that does not fit is a contradiction (Malformed), not a truncation.
    if (message.len - 4 < body_len) return error.Truncated;
    if (message.len - 4 > body_len) return error.Malformed;
    var r: Reader = .{ .bytes = message[4..] };

    // ---- ClientHello body (8446 §4.1.2 / 9846 §4.2.2) --------------------------------------------
    // legacy_version: ProtocolVersion = uint16. TLS 1.3 clients send 0x0303 and put the real versions in
    // supported_versions; the value is kept as-is (JA3 uses it) and not validated.
    const legacy_version = try r.int(u16);

    // random: opaque Random[32]. Fixed-size vector -> no length prefix; always exactly 32 bytes.
    const random = (try r.take(32))[0..32];

    // legacy_session_id: opaque <0..32>. Ceiling 32 -> 1-byte prefix. A prefix of 33..255 is
    // representable on the wire but outside the range -> Malformed. TLS 1.3 browsers send 32 random
    // bytes ("compatibility mode", 9846 Appendix E.4).
    const session_id = try r.vector(u8, 0, 32);

    // cipher_suites: CipherSuite cipher_suites<2..2^16-2>, CipherSuite = uint8[2]. Ceiling needs two
    // bytes -> 2-byte prefix. The prefix counts bytes: it must be even and at least 2 (one suite).
    // GREASE values (RFC 8701) are ordinary entries here; the fingerprint layer decides what to skip.
    const suites = try r.vector(u16, 2, 0xfffe);
    if (suites.len % 2 != 0) return error.Malformed;

    // legacy_compression_methods: opaque <1..2^8-1>. 1-byte prefix, at least one method (TLS 1.3
    // requires exactly [0x00], but a TLS 1.2 client may list more; not a structural error).
    const compression_methods = try r.vector(u8, 1, 0xff);

    // extensions: Extension extensions<8..2^16-1> (9846: <7..2^16-1>). 2-byte prefix.
    // The whole field is optional for pre-1.3 clients: "The presence of extensions can be detected by
    // determining whether there are bytes following the compression_methods field" (9846 §4.2.2), and
    // RFC 5246 §7.4.1.2 allows `<0..2^16-1>`. We accept both, so old clients can be fingerprinted; with
    // no field, `extensions` is the empty slice at the end of the message.
    var extensions: []const u8 = r.bytes[r.pos..r.pos];
    if (!r.atEnd()) {
        extensions = try r.vector(u16, 0, 0xffff);
        // "...a valid extensions block with no data following. If not, then it MUST abort the handshake
        // with a "decode_error" alert." (9846 §4.2.2)
        try r.expectEnd();
    }
    const extension_count = try validateExtensions(extensions);

    return .{
        .message = message,
        .legacy_version = legacy_version,
        .random = random,
        .session_id = session_id,
        .cipher_suites = .{ .bytes = suites },
        .compression_methods = compression_methods,
        .extensions = extensions,
        .extension_count = extension_count,
    };
}

/// Walks the extension block once: it must be tiled exactly by type(2) + length(2) + data records, and
/// no type may repeat ("There MUST NOT be more than one extension of the same type in a given extension
/// block", 8446 §4.2 / 9846 §4.3). Returns the number of extensions.
fn validateExtensions(block: []const u8) ParseError!usize {
    // One bit per possible u16 type: 8 KiB, O(1) per extension. (A pairwise comparison would be
    // quadratic, and a 64 KiB block can hold 16383 empty extensions.)
    var seen: std.StaticBitSet(1 << 16) = .empty;
    var it: ExtensionIterator = .{ .bytes = block };
    var count: usize = 0;
    while (try it.next()) |e| {
        if (seen.isSet(e.kind)) return error.Malformed;
        seen.set(e.kind);
        count += 1;
    }
    return count;
}

/// Decodes `data` as exactly one `uint16 list<floor..ceiling>` with a `Len`-sized prefix.
fn u16ListBody(data: []const u8, comptime Len: type, floor: usize, ceiling: usize) ParseError!U16List {
    var r: Reader = .{ .bytes = data };
    const list = try r.vector(Len, floor, ceiling);
    // "a 17-byte vector of uint16 would be illegal" (8446 §3.4 / 9846 §3.4)
    if (list.len % 2 != 0) return error.Malformed;
    try r.expectEnd();
    return .{ .bytes = list };
}

/// Cursor over a complete, length-delimited container (the ClientHello body, an extension block, one
/// extension's data). The container's own length has already been accepted, so running off its end
/// means an inner length contradicts an outer one: every failure here is error.Malformed.
const Reader = struct {
    bytes: []const u8,
    pos: usize = 0, // invariant: pos <= bytes.len

    const Error = error{Malformed};

    fn atEnd(r: *const Reader) bool {
        return r.pos >= r.bytes.len;
    }

    /// The next `n` bytes, borrowed.
    fn take(r: *Reader, n: usize) Error![]const u8 {
        if (n > r.bytes.len - r.pos) return error.Malformed;
        const out = r.bytes[r.pos..][0..n];
        r.pos += n;
        return out;
    }

    /// A big-endian unsigned integer of 1, 2 or 3 bytes (uint8 / uint16 / uint24, §3.3).
    fn int(r: *Reader, comptime T: type) Error!T {
        const n = @divExact(@typeInfo(T).int.bits, 8);
        const b = try r.take(n);
        return std.mem.readInt(T, b[0..n], .big);
    }

    /// `opaque v<floor..ceiling>` whose length prefix is a `Len` (u8 or u16): read the prefix, check the
    /// range, then take that many bytes. The ceiling of the notation decides `Len`; see the file header.
    fn vector(r: *Reader, comptime Len: type, floor: usize, ceiling: usize) Error![]const u8 {
        const n: usize = try r.int(Len);
        if (n < floor or n > ceiling) return error.Malformed;
        return r.take(n); // Malformed if the inner length runs past the container
    }

    /// Nothing may follow the structure just read (8446 §4.2 / 9846 §4.3: "trailing data is forbidden").
    fn expectEnd(r: *const Reader) Error!void {
        if (!r.atEnd()) return error.Malformed;
    }
};

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const fixtures = @import("fixtures");
const spec = @import("spec");
const hex = @import("../hex.zig");
const grease = @import("grease.zig");
const record = @import("record.zig");

fn expectedJson(name: []const u8) ![]const u8 {
    for (fixtures.clienthello_expected.all) |e| {
        if (std.mem.eql(u8, e.name, name)) return e.json;
    }
    return error.TestExpectedFixture;
}

fn jsonGet(obj: std.json.Value, key: []const u8) !std.json.Value {
    if (obj != .object) return error.TestUnexpectedJson;
    return obj.object.get(key) orelse error.TestUnexpectedJson;
}

fn expectHex(expected_hex: []const u8, actual: []const u8) !void {
    const buf = try testing.allocator.alloc(u8, actual.len * 2);
    defer testing.allocator.free(buf);
    try testing.expectEqualStrings(expected_hex, hex.encode(buf, actual));
}

fn parseHexU16(text: []const u8) !u16 {
    return std.fmt.parseInt(u16, text, 16);
}

fn containsU16(list: U16List, v: u16) bool {
    for (0..list.len()) |i| {
        if (list.at(i) == v) return true;
    }
    return false;
}

/// Does `slice` lie inside `outer`? (zero-copy check)
fn within(outer: []const u8, slice: []const u8) bool {
    const o = @intFromPtr(outer.ptr);
    const s = @intFromPtr(slice.ptr);
    return s >= o and s + slice.len <= o + outer.len;
}

/// Extension types in wire order (test helper; allocates).
fn extensionKinds(gpa: std.mem.Allocator, ch: *const ClientHello) ![]u16 {
    var kinds: std.ArrayList(u16) = .empty;
    errdefer kinds.deinit(gpa);
    var it = ch.iterateExtensions();
    while (try it.next()) |e| try kinds.append(gpa, e.kind);
    return kinds.toOwnedSlice(gpa);
}

fn fixtureMessage(bytes: []const u8) ![]const u8 {
    var scratch: [1]u8 = undefined; // all fixtures are single-record
    return (try record.firstHandshakeMessage(bytes, &scratch)).bytes;
}

test "fixtures: fields match the OpenSSL oracle" {
    const gpa = testing.allocator;
    for (fixtures.clienthello.all) |fx| {
        const parsed = try std.json.parseFromSlice(std.json.Value, gpa, try expectedJson(fx.name), .{});
        defer parsed.deinit();
        const want = parsed.value;

        const message = try fixtureMessage(fx.bytes);
        const ch = try parse(message);

        // Fixed-position fields.
        try testing.expectEqualStrings((try jsonGet(want, "legacy_version")).string, &hex.u16Hex(ch.legacy_version));
        try expectHex((try jsonGet(want, "random")).string, ch.random);
        try expectHex((try jsonGet(want, "session_id")).string, ch.session_id);
        try expectHex((try jsonGet(want, "compression_methods")).string, ch.compression_methods);

        // Cipher suites: same values, same order, GREASE included.
        const suites = (try jsonGet(want, "cipher_suites")).array.items;
        try testing.expectEqual(suites.len, ch.cipher_suites.len());
        for (suites, 0..) |s, i| {
            try testing.expectEqualStrings(s.string, &hex.u16Hex(ch.cipher_suites.at(i)));
        }

        // Zero-copy: every slice points into the message.
        try testing.expect(within(message, ch.random));
        try testing.expect(within(message, ch.session_id));
        try testing.expect(within(message, ch.cipher_suites.bytes));
        try testing.expect(within(message, ch.compression_methods));
        try testing.expect(within(message, ch.extensions));

        // The extension block tiles exactly and ends where the message ends.
        var covered: usize = 0;
        var count: usize = 0;
        var it = ch.iterateExtensions();
        while (try it.next()) |e| {
            covered += 4 + e.data.len;
            count += 1;
        }
        try testing.expectEqual(ch.extensions.len, covered);
        try testing.expectEqual(ch.extension_count, count);
        try testing.expectEqual(@intFromPtr(message.ptr) + message.len, @intFromPtr(ch.extensions.ptr) + ch.extensions.len);

        // Recognised extensions: OpenSSL's order is a subsequence of ours ...
        const ours = try extensionKinds(gpa, &ch);
        defer gpa.free(ours);
        const order = (try jsonGet(want, "recognized_extension_order")).array.items;
        var j: usize = 0;
        for (ours) |k| {
            if (j < order.len and k == try parseHexU16(order[j].string)) j += 1;
        }
        try testing.expectEqual(order.len, j);
        // ... and exactly equal to ours filtered by the set OpenSSL can see at all (its get0_ext probe
        // over all 65536 types). So no recognised extension is missing, extra, or out of place.
        const probe = (try jsonGet(want, "get0_ext_present_types")).array.items;
        var filtered: std.ArrayList(u16) = .empty;
        defer filtered.deinit(gpa);
        for (ours) |k| {
            for (probe) |p| {
                if (k == try parseHexU16(p.string)) {
                    try filtered.append(gpa, k);
                    break;
                }
            }
        }
        try testing.expectEqual(order.len, filtered.items.len);
        for (order, filtered.items) |o, k| try testing.expectEqual(try parseHexU16(o.string), k);

        // extension_data of every recognised extension, byte for byte.
        const exts = (try jsonGet(want, "recognized_extensions")).object;
        var eit = exts.iterator();
        while (eit.next()) |entry| {
            const data = ch.findExtension(try parseHexU16(entry.key_ptr.*)) orelse return error.TestExpectedExtension;
            try expectHex(entry.value_ptr.string, data);
        }
    }
}

test "fixtures: decoders on real browsers" {
    const gpa = testing.allocator;
    for (fixtures.clienthello.all) |fx| {
        const ch = try parse(try fixtureMessage(fx.bytes));

        // SNI: the capture opened https://localhost:<port>/.
        try testing.expectEqualStrings("localhost", (try ch.serverName()).?);

        // ALPN: exactly h2, http/1.1.
        var protocols = (try ch.alpn()).?;
        try testing.expectEqualStrings("h2", (try protocols.next()).?);
        try testing.expectEqualStrings("http/1.1", (try protocols.next()).?);
        try testing.expectEqual(@as(?[]const u8, null), try protocols.next());

        // TLS 1.3 offered; decoder output is the extension body minus its own length prefix.
        const versions = (try ch.supportedVersions()).?;
        try testing.expect(containsU16(versions, 0x0304));
        try testing.expectEqualSlices(u8, ch.findExtension(ext.supported_versions).?[1..], versions.bytes);

        // X25519MLKEM768 (0x11ec) both offered and shared; its share is 1184 + 32 = 1216 bytes.
        const groups = (try ch.supportedGroups()).?;
        try testing.expect(containsU16(groups, 0x11ec));
        try testing.expectEqualSlices(u8, ch.findExtension(ext.supported_groups).?[2..], groups.bytes);
        var shares = (try ch.keyShares()).?;
        var mlkem_len: ?usize = null;
        while (try shares.next()) |s| {
            try testing.expect(s.key_exchange.len >= 1);
            if (s.group == 0x11ec) mlkem_len = s.key_exchange.len;
        }
        try testing.expectEqual(@as(?usize, 1216), mlkem_len);

        const sigalgs = (try ch.signatureAlgorithms()).?;
        try testing.expect(sigalgs.len() >= 1);
        try testing.expectEqualSlices(u8, ch.findExtension(ext.signature_algorithms).?[2..], sigalgs.bytes);
        const formats = (try ch.ecPointFormats()).?;
        try testing.expectEqualSlices(u8, ch.findExtension(ext.ec_point_formats).?[1..], formats);

        const kinds = try extensionKinds(gpa, &ch);
        defer gpa.free(kinds);
        const has = struct {
            fn f(list: []const u16, v: u16) bool {
                return std.mem.indexOfScalar(u16, list, v) != null;
            }
        }.f;
        if (std.mem.startsWith(u8, fx.name, "chrome")) {
            try testing.expect(has(kinds, ext.trust_anchors));
            try testing.expect(has(kinds, ext.application_settings));
        }
        if (std.mem.startsWith(u8, fx.name, "safari")) {
            try testing.expect(!has(kinds, ext.encrypted_client_hello));
        }
        // Resumption: pre_shared_key is present and last (8446 §4.2.11 / 9846 §4.3.11).
        if (std.mem.endsWith(u8, fx.name, "-psk")) {
            try testing.expectEqual(ext.pre_shared_key, kinds[kinds.len - 1]);
        } else {
            try testing.expect(!has(kinds, ext.pre_shared_key));
        }
    }
}

test "fixtures: Chrome permutes extensions (same set modulo GREASE, different order)" {
    const gpa = testing.allocator;
    const a = try parse(try fixtureMessage(fixtures.clienthello.chrome_153_macos_1));
    const b = try parse(try fixtureMessage(fixtures.clienthello.chrome_153_macos_2));
    const ka = try extensionKinds(gpa, &a);
    defer gpa.free(ka);
    const kb = try extensionKinds(gpa, &b);
    defer gpa.free(kb);
    // GREASE values are re-rolled per connection, so compare them as one stand-in value.
    for (ka) |*k| if (grease.isGrease(k.*)) {
        k.* = 0x0a0a;
    };
    for (kb) |*k| if (grease.isGrease(k.*)) {
        k.* = 0x0a0a;
    };
    try testing.expect(!std.mem.eql(u16, ka, kb)); // wire order differs
    std.mem.sort(u16, ka, {}, std.sort.asc(u16));
    std.mem.sort(u16, kb, {}, std.sort.asc(u16));
    try testing.expectEqualSlices(u16, ka, kb); // same multiset
}

// ---- test-only encoder: builds ClientHello bytes for synthetic inputs (not product code) -------------

const Enc = struct {
    buf: std.ArrayList(u8) = .empty,
    gpa: std.mem.Allocator,

    fn deinit(e: *Enc) void {
        e.buf.deinit(e.gpa);
    }
    fn byte(e: *Enc, v: u8) !void {
        try e.buf.append(e.gpa, v);
    }
    fn u16be(e: *Enc, v: u16) !void {
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, v, .big);
        try e.buf.appendSlice(e.gpa, &b);
    }
    fn bytes(e: *Enc, b: []const u8) !void {
        try e.buf.appendSlice(e.gpa, b);
    }
    fn vec8(e: *Enc, b: []const u8) !void {
        try e.byte(@intCast(b.len));
        try e.bytes(b);
    }
    fn vec16(e: *Enc, b: []const u8) !void {
        try e.u16be(@intCast(b.len));
        try e.bytes(b);
    }
    fn u16s(e: *Enc, values: []const u16) !void {
        for (values) |v| try e.u16be(v);
    }
    /// Wraps the current contents as a handshake message body: type 1 + uint24 length + body.
    fn message(e: *Enc, msg_type: u8) ![]u8 {
        const body = e.buf.items;
        const out = try e.gpa.alloc(u8, 4 + body.len);
        out[0] = msg_type;
        std.mem.writeInt(u24, out[1..4], @intCast(body.len), .big);
        @memcpy(out[4..], body);
        return out;
    }
};

const TestExt = struct { kind: u16, data: []const u8 };

/// A ClientHello message with the given suites and extensions (null = no extensions field at all).
fn buildHello(gpa: std.mem.Allocator, suites: []const u16, exts: ?[]const TestExt) ![]u8 {
    var e: Enc = .{ .gpa = gpa };
    defer e.deinit();
    try e.u16be(0x0303);
    try e.bytes(&([_]u8{0x11} ** 32));
    try e.vec8(&([_]u8{0x22} ** 32));
    var s: Enc = .{ .gpa = gpa };
    defer s.deinit();
    try s.u16s(suites);
    try e.vec16(s.buf.items);
    try e.vec8(&.{0x00});
    if (exts) |list| {
        var block: Enc = .{ .gpa = gpa };
        defer block.deinit();
        for (list) |x| {
            try block.u16be(x.kind);
            try block.vec16(x.data);
        }
        try e.vec16(block.buf.items);
    }
    return e.message(handshake_type_client_hello);
}

test "official JA4 example input: build a ClientHello, parse, read every list back" {
    const gpa = testing.allocator;
    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, spec.test_vectors_json, .{});
    defer parsed.deinit();
    const input = try jsonGet(try jsonGet(try jsonGet(parsed.value, "ja4"), "official_example"), "input");

    var suites: std.ArrayList(u16) = .empty;
    defer suites.deinit(gpa);
    for ((try jsonGet(input, "cipher_suites_original")).array.items) |v| try suites.append(gpa, try parseHexU16(v.string));
    var sigalgs: Enc = .{ .gpa = gpa };
    defer sigalgs.deinit();
    for ((try jsonGet(input, "signature_algorithms_original")).array.items) |v| try sigalgs.u16be(try parseHexU16(v.string));
    const alpn_first = (try jsonGet(input, "alpn_first")).string;
    const highest = try parseHexU16((try jsonGet(input, "supported_versions_highest")).string);

    // Extension bodies: well-formed for the ones we decode, empty for the rest (opaque to `parse`).
    var sni: Enc = .{ .gpa = gpa };
    defer sni.deinit();
    {
        var entry: Enc = .{ .gpa = gpa };
        defer entry.deinit();
        try entry.byte(0); // host_name
        try entry.vec16("example.com");
        try sni.vec16(entry.buf.items);
    }
    var alpn_body: Enc = .{ .gpa = gpa };
    defer alpn_body.deinit();
    {
        var names: Enc = .{ .gpa = gpa };
        defer names.deinit();
        try names.vec8(alpn_first);
        try alpn_body.vec16(names.buf.items);
    }
    var sig_body: Enc = .{ .gpa = gpa };
    defer sig_body.deinit();
    try sig_body.vec16(sigalgs.buf.items);
    var versions: Enc = .{ .gpa = gpa };
    defer versions.deinit();
    {
        var v: Enc = .{ .gpa = gpa };
        defer v.deinit();
        try v.u16be(highest);
        try versions.vec8(v.buf.items);
    }

    var ext_kinds: std.ArrayList(u16) = .empty;
    defer ext_kinds.deinit(gpa);
    var exts: std.ArrayList(TestExt) = .empty;
    defer exts.deinit(gpa);
    for ((try jsonGet(input, "extensions_original")).array.items) |v| {
        const kind = try parseHexU16(v.string);
        try ext_kinds.append(gpa, kind);
        const data: []const u8 = switch (kind) {
            ext.server_name => sni.buf.items,
            ext.alpn => alpn_body.buf.items,
            ext.signature_algorithms => sig_body.buf.items,
            ext.supported_versions => versions.buf.items,
            else => &.{},
        };
        try exts.append(gpa, .{ .kind = kind, .data = data });
    }

    const message = try buildHello(gpa, suites.items, exts.items);
    defer gpa.free(message);
    const ch = try parse(message);

    try testing.expectEqual(suites.items.len, ch.cipher_suites.len());
    for (suites.items, 0..) |s, i| try testing.expectEqual(s, ch.cipher_suites.at(i));
    const kinds = try extensionKinds(gpa, &ch);
    defer gpa.free(kinds);
    try testing.expectEqualSlices(u16, ext_kinds.items, kinds);
    try testing.expectEqual(ext_kinds.items.len, ch.extension_count);
    try testing.expectEqualSlices(u8, sigalgs.buf.items, (try ch.signatureAlgorithms()).?.bytes);
    var protocols = (try ch.alpn()).?;
    try testing.expectEqualStrings(alpn_first, (try protocols.next()).?);
    try testing.expect((try ch.serverName()) != null); // sni_present
    try testing.expect(containsU16((try ch.supportedVersions()).?, highest));
}

test "truncating the message at any byte is error.Truncated" {
    // Covers every boundary: handshake header (0..3), legacy_version, random, session_id length and
    // bytes, cipher list, compression methods, and every offset inside the extension block.
    for (fixtures.clienthello.all) |fx| {
        const message = try fixtureMessage(fx.bytes);
        const ch = try parse(message);
        // The layout of the named boundaries, as the RFC puts them (4-byte header, 2-byte version, ...).
        const off = struct {
            fn f(m: []const u8, s: []const u8) usize {
                return @intFromPtr(s.ptr) - @intFromPtr(m.ptr);
            }
        }.f;
        try testing.expectEqual(@as(usize, 6), off(message, ch.random));
        try testing.expectEqual(@as(usize, 6 + 32 + 1), off(message, ch.session_id));
        try testing.expectEqual(off(message, ch.session_id) + ch.session_id.len + 2, off(message, ch.cipher_suites.bytes));
        try testing.expectEqual(off(message, ch.cipher_suites.bytes) + ch.cipher_suites.bytes.len + 1, off(message, ch.compression_methods));
        try testing.expectEqual(off(message, ch.compression_methods) + ch.compression_methods.len + 2, off(message, ch.extensions));
        for (0..message.len) |k| {
            try testing.expectError(error.Truncated, parse(message[0..k]));
        }
    }
}

test "wrong handshake type is error.NotClientHello" {
    const gpa = testing.allocator;
    const copy = try gpa.dupe(u8, try fixtureMessage(fixtures.clienthello.firefox_157b4_macos_1));
    defer gpa.free(copy);
    copy[0] = 2; // server_hello
    try testing.expectError(error.NotClientHello, parse(copy));
    try testing.expectError(error.NotClientHello, parse(copy[0..1]));
    try testing.expectError(error.Truncated, parse(&.{}));
}

/// Builds a message from a raw body (lengths written by hand) and expects `err` from `parse`.
fn expectBody(err: ParseError, body_parts: []const []const u8) !void {
    const gpa = testing.allocator;
    var e: Enc = .{ .gpa = gpa };
    defer e.deinit();
    for (body_parts) |p| try e.bytes(p);
    const m = try e.message(handshake_type_client_hello);
    defer gpa.free(m);
    try testing.expectError(err, parse(m));
}

test "contradictory lengths in the ClientHello body are error.Malformed" {
    const v = &[_]u8{ 0x03, 0x03 };
    const rnd = &([_]u8{0x11} ** 32);
    const sid0 = &[_]u8{0x00};
    const suite = &[_]u8{ 0x00, 0x02, 0x13, 0x01 };
    const comp = &[_]u8{ 0x01, 0x00 };

    // Baseline (no extensions field, TLS 1.2 style) is valid.
    {
        const gpa = testing.allocator;
        var e: Enc = .{ .gpa = gpa };
        defer e.deinit();
        for ([_][]const u8{ v, rnd, sid0, suite, comp }) |p| try e.bytes(p);
        const m = try e.message(handshake_type_client_hello);
        defer gpa.free(m);
        const ch = try parse(m);
        try testing.expectEqual(@as(usize, 0), ch.extensions.len);
        try testing.expectEqual(@as(usize, 0), ch.extension_count);
        try testing.expectEqual(@as(?[]const u8, null), ch.findExtension(ext.server_name));
        try testing.expectEqual(@as(?[]const u8, null), try ch.serverName());
        try testing.expect((try ch.keyShares()) == null);
    }

    // Body shorter than legacy_version + random (the handshake length itself is consistent).
    try expectBody(error.Malformed, &.{ v, rnd[0..10] });
    // session_id longer than 32 (all 33 bytes present).
    try expectBody(error.Malformed, &.{ v, rnd, &[_]u8{33}, &([_]u8{0} ** 33), suite, comp });
    // session_id length runs past the body.
    try expectBody(error.Malformed, &.{ v, rnd, &[_]u8{32}, &([_]u8{0} ** 5) });
    // cipher_suites: empty, odd, and longer than what is left.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, &[_]u8{ 0x00, 0x00 }, comp });
    try expectBody(error.Malformed, &.{ v, rnd, sid0, &[_]u8{ 0x00, 0x03, 0x13, 0x01, 0x13 }, comp });
    try expectBody(error.Malformed, &.{ v, rnd, sid0, &[_]u8{ 0x01, 0x00, 0x13, 0x01 }, comp });
    // compression methods: empty list; missing entirely.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, &[_]u8{0x00} });
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite });
    // One stray byte where the 2-byte extensions length should be.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, comp, &[_]u8{0x00} });
    // Extensions length larger than what follows.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, comp, &[_]u8{ 0x00, 0x08, 0x00, 0x17, 0x00, 0x00 } });
    // Data after the extensions block.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, comp, &[_]u8{ 0x00, 0x04, 0x00, 0x17, 0x00, 0x00, 0xff } });
    // Block not tiled: 2 bytes left over after a complete extension.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, comp, &[_]u8{ 0x00, 0x06, 0x00, 0x17, 0x00, 0x00, 0x00, 0x2b } });
    // Block not tiled: an extension's data length runs past the block.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, comp, &[_]u8{ 0x00, 0x05, 0x00, 0x17, 0x00, 0x02, 0x00 } });
    // Duplicate extension type.
    try expectBody(error.Malformed, &.{ v, rnd, sid0, suite, comp, &[_]u8{ 0x00, 0x08, 0x00, 0x17, 0x00, 0x00, 0x00, 0x17, 0x00, 0x00 } });
    // An empty extensions block is valid (TLS 1.2 `<0..2^16-1>`).
    {
        const gpa = testing.allocator;
        var e: Enc = .{ .gpa = gpa };
        defer e.deinit();
        for ([_][]const u8{ v, rnd, sid0, suite, comp, &[_]u8{ 0x00, 0x00 } }) |p| try e.bytes(p);
        const m = try e.message(handshake_type_client_hello);
        defer gpa.free(m);
        try testing.expectEqual(@as(usize, 0), (try parse(m)).extension_count);
    }

    // More bytes than the handshake header announces.
    const gpa = testing.allocator;
    const real = try fixtureMessage(fixtures.clienthello.safari_26_6_2_macos_1);
    const longer = try std.mem.concat(gpa, u8, &.{ real, &[_]u8{0x00} });
    defer gpa.free(longer);
    try testing.expectError(error.Malformed, parse(longer));
}

/// A ClientHello with a single extension, then `decode` on it must fail with Malformed.
fn expectExtMalformed(kind: u16, data: []const u8) !void {
    const gpa = testing.allocator;
    const m = try buildHello(gpa, &.{0x1301}, &.{.{ .kind = kind, .data = data }});
    defer gpa.free(m);
    const ch = try parse(m); // the block itself is fine: extension bodies are opaque to `parse`
    switch (kind) {
        ext.server_name => try testing.expectError(error.Malformed, ch.serverName()),
        ext.alpn => try testing.expectError(error.Malformed, ch.alpn()),
        ext.supported_versions => try testing.expectError(error.Malformed, ch.supportedVersions()),
        ext.supported_groups => try testing.expectError(error.Malformed, ch.supportedGroups()),
        ext.signature_algorithms => try testing.expectError(error.Malformed, ch.signatureAlgorithms()),
        ext.key_share => try testing.expectError(error.Malformed, ch.keyShares()),
        ext.ec_point_formats => try testing.expectError(error.Malformed, ch.ecPointFormats()),
        else => return error.TestUnexpectedExtension,
    }
}

test "extension decoders reject malformed bodies" {
    // server_name: empty data; list length mismatch; empty list; unknown name_type; empty host;
    // two host_name entries; trailing byte after the list.
    try expectExtMalformed(ext.server_name, &.{});
    try expectExtMalformed(ext.server_name, &.{ 0x00, 0x09, 0x00, 0x00, 0x01, 'a' });
    try expectExtMalformed(ext.server_name, &.{ 0x00, 0x00 });
    try expectExtMalformed(ext.server_name, &.{ 0x00, 0x04, 0x01, 0x00, 0x01, 'a' });
    try expectExtMalformed(ext.server_name, &.{ 0x00, 0x03, 0x00, 0x00, 0x00 });
    try expectExtMalformed(ext.server_name, &.{ 0x00, 0x08, 0x00, 0x00, 0x01, 'a', 0x00, 0x00, 0x01, 'b' });
    try expectExtMalformed(ext.server_name, &.{ 0x00, 0x04, 0x00, 0x00, 0x01, 'a', 0xff });
    // ALPN: empty protocol name; list shorter than 2; a name running past the list; trailing byte.
    try expectExtMalformed(ext.alpn, &.{ 0x00, 0x03, 0x00, 0x01, 'a' });
    try expectExtMalformed(ext.alpn, &.{ 0x00, 0x00 });
    try expectExtMalformed(ext.alpn, &.{ 0x00, 0x03, 0x02, 'h', '2', 0x05 });
    try expectExtMalformed(ext.alpn, &.{ 0x00, 0x03, 0x05, 'h', '2' });
    try expectExtMalformed(ext.alpn, &.{ 0x00, 0x03, 0x02, 'h', '2', 0x00 });
    // supported_versions (1-byte prefix): empty, odd, prefix longer than data, trailing byte.
    try expectExtMalformed(ext.supported_versions, &.{0x00});
    try expectExtMalformed(ext.supported_versions, &.{ 0x03, 0x03, 0x04, 0x03 });
    try expectExtMalformed(ext.supported_versions, &.{ 0x04, 0x03, 0x04 });
    try expectExtMalformed(ext.supported_versions, &.{ 0x02, 0x03, 0x04, 0x00 });
    // supported_groups / signature_algorithms (2-byte prefix): empty list, odd length.
    try expectExtMalformed(ext.supported_groups, &.{ 0x00, 0x00 });
    try expectExtMalformed(ext.supported_groups, &.{ 0x00, 0x03, 0x00, 0x1d, 0x00 });
    try expectExtMalformed(ext.signature_algorithms, &.{ 0x00, 0x00 });
    try expectExtMalformed(ext.signature_algorithms, &.{ 0x00, 0x01, 0x04 });
    try expectExtMalformed(ext.signature_algorithms, &.{0x00});
    // key_share: zero-length key; entry header cut by the list end; key running past the list;
    // trailing byte after the list.
    try expectExtMalformed(ext.key_share, &.{ 0x00, 0x04, 0x00, 0x1d, 0x00, 0x00 });
    try expectExtMalformed(ext.key_share, &.{ 0x00, 0x03, 0x00, 0x1d, 0x00 });
    try expectExtMalformed(ext.key_share, &.{ 0x00, 0x05, 0x00, 0x1d, 0x00, 0x02, 0xaa });
    try expectExtMalformed(ext.key_share, &.{ 0x00, 0x00, 0x00 });
    // ec_point_formats: empty list, prefix longer than data.
    try expectExtMalformed(ext.ec_point_formats, &.{0x00});
    try expectExtMalformed(ext.ec_point_formats, &.{ 0x02, 0x00 });

    // Valid edge cases: empty key_share list (HelloRetryRequest request), minimal lists.
    const gpa = testing.allocator;
    const m = try buildHello(gpa, &.{0x1301}, &.{
        .{ .kind = ext.key_share, .data = &.{ 0x00, 0x00 } },
        .{ .kind = ext.ec_point_formats, .data = &.{ 0x01, 0x00 } },
        .{ .kind = ext.supported_versions, .data = &.{ 0x02, 0x03, 0x04 } },
    });
    defer gpa.free(m);
    const ch = try parse(m);
    var shares = (try ch.keyShares()).?;
    try testing.expectEqual(@as(?KeyShareEntry, null), try shares.next());
    try testing.expectEqualSlices(u8, &.{0x00}, (try ch.ecPointFormats()).?);
    try testing.expectEqual(@as(u16, 0x0304), (try ch.supportedVersions()).?.at(0));
}

/// Runs every accessor on whatever `parse` makes of `message`; errors are fine, panics are not.
fn exercise(message: []const u8) void {
    const ch = parse(message) catch return;
    var it = ch.iterateExtensions();
    while (it.next() catch null) |e| _ = ch.findExtension(e.kind);
    _ = ch.serverName() catch {};
    if (ch.alpn() catch null) |a| {
        var names = a;
        while (names.next() catch null) |_| {}
    }
    if (ch.keyShares() catch null) |k| {
        var shares = k;
        while (shares.next() catch null) |_| {}
    }
    if (ch.supportedVersions() catch null) |l| for (0..l.len()) |i| std.mem.doNotOptimizeAway(l.at(i));
    if (ch.supportedGroups() catch null) |l| for (0..l.len()) |i| std.mem.doNotOptimizeAway(l.at(i));
    if (ch.signatureAlgorithms() catch null) |l| for (0..l.len()) |i| std.mem.doNotOptimizeAway(l.at(i));
    for (0..ch.cipher_suites.len()) |i| std.mem.doNotOptimizeAway(ch.cipher_suites.at(i));
    _ = ch.ecPointFormats() catch {};
}

test "corrupting any single byte never panics: every outcome is a value or an error" {
    // Debug builds bounds-check every slice access, so an out-of-bounds read would abort this test.
    const gpa = testing.allocator;
    var scratch: [4096]u8 = undefined;
    for (fixtures.clienthello.all) |fx| {
        const stream = try gpa.dupe(u8, fx.bytes);
        defer gpa.free(stream);
        for (0..stream.len) |i| {
            const saved = stream[i];
            for ([_]u8{ 0x00, 0xff, saved ^ 0x01 }) |v| {
                stream[i] = v;
                // Through the record layer, and straight into the parser (to reach past a broken header).
                if (record.firstHandshakeMessage(stream, &scratch)) |m| exercise(m.bytes) else |_| {}
                exercise(stream[record.record_header_len..]);
            }
            stream[i] = saved;
        }
    }
}
