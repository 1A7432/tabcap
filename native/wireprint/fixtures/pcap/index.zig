//! Synthetic legacy pcap files built by tools/mkpcap.py from the real ClientHello bytes in ../clienthello/
//! (see README.md in this directory). Regenerate with `python3 tools/mkpcap.py` from the repo root; the
//! script is idempotent, so a clean rerun must leave every file byte-identical.
//!
//! Each `<name>.pcap` has a sibling `<name>.expected.json` written by the same script from the values it
//! put on the wire. Tests read expectations from that JSON (schema: `Expected`), never from the Zig
//! parsers under test.
const std = @import("std");

pub const Fixture = struct {
    name: []const u8,
    bytes: []const u8,
    expected_json: []const u8,
};

pub const chrome_153_macos_lo0_1seg: Fixture = .{
    .name = "chrome-153-macos-lo0-1seg",
    .bytes = @embedFile("chrome-153-macos-lo0-1seg.pcap"),
    .expected_json = @embedFile("chrome-153-macos-lo0-1seg.expected.json"),
};
pub const chrome_153_macos_en0_2seg: Fixture = .{
    .name = "chrome-153-macos-en0-2seg",
    .bytes = @embedFile("chrome-153-macos-en0-2seg.pcap"),
    .expected_json = @embedFile("chrome-153-macos-en0-2seg.expected.json"),
};
pub const firefox_157b4_macos_v6_1seg: Fixture = .{
    .name = "firefox-157b4-macos-v6-1seg",
    .bytes = @embedFile("firefox-157b4-macos-v6-1seg.pcap"),
    .expected_json = @embedFile("firefox-157b4-macos-v6-1seg.expected.json"),
};
pub const safari_26_6_2_macos_nano: Fixture = .{
    .name = "safari-26.6.2-macos-nano",
    .bytes = @embedFile("safari-26.6.2-macos-nano.pcap"),
    .expected_json = @embedFile("safari-26.6.2-macos-nano.expected.json"),
};
pub const syn_only: Fixture = .{
    .name = "syn-only",
    .bytes = @embedFile("syn-only.pcap"),
    .expected_json = @embedFile("syn-only.expected.json"),
};
pub const truncated: Fixture = .{
    .name = "truncated",
    .bytes = @embedFile("truncated.pcap"),
    .expected_json = @embedFile("truncated.expected.json"),
};

pub const all = [_]Fixture{
    chrome_153_macos_lo0_1seg,
    chrome_153_macos_en0_2seg,
    firefox_157b4_macos_v6_1seg,
    safari_26_6_2_macos_nano,
    syn_only,
    truncated,
};

/// Typed view of `<name>.expected.json` (unknown keys such as `note`, `src`, `flag_names` are
/// human-readable extras and are ignored).
pub const Expected = struct {
    name: []const u8,
    file_len: usize,
    file_sha256: []const u8,
    /// First four bytes of the file, lowercase hex (e.g. "d4c3b2a1" = little-endian microseconds).
    magic_bytes: []const u8,
    endian: std.builtin.Endian,
    nanosecond: bool,
    version_major: u16,
    version_minor: u16,
    snaplen: u32,
    linktype: u32,
    /// Number of complete records; `records` lists exactly these.
    record_count: u32,
    /// Error name the reader must return after the complete records (null: clean end of file).
    trailing_error: ?[]const u8,
    records: []const Record,
    /// The client side of the TCP connection (null when the file has no usable connection).
    client: ?Client,

    pub const Record = struct {
        index: u32,
        /// File offset of the 16-byte record header.
        offset: usize,
        ts_sec: u32,
        ts_frac: u32,
        incl_len: u32,
        orig_len: u32,
        /// Error name the frame parser must return (e.g. "Unsupported" for ARP/UDP), else null.
        parse_error: ?[]const u8,
        packet: ?Packet,
    };

    pub const Packet = struct {
        ip_version: u8,
        /// IPv6 extension header types walked before TCP, in order (empty for IPv4).
        ip_ext_headers: []const u16,
        /// DLT_NULL 4, Ethernet 14.
        link_header_len: u32,
        /// IPv4 total length / 40 + IPv6 payload length; bytes after it in the frame are link padding.
        ip_len: u32,
        src_hex: []const u8,
        dst_hex: []const u8,
        ttl: u8,
        src_port: u16,
        dst_port: u16,
        seq: u32,
        ack: u32,
        data_offset: u8,
        flags: u8,
        window: u16,
        options_hex: []const u8,
        /// Option kinds a TCP option iterator yields (stops after the first EOL).
        option_kinds: []const u16,
        mss: ?u16,
        wscale: ?u8,
        payload_len: u32,
    };

    pub const Syn = struct {
        window: u16,
        ttl: u8,
        options_hex: []const u8,
        option_kinds: []const u16,
        mss: ?u16,
        wscale: ?u8,
    };

    pub const Client = struct {
        ip_version: u8,
        src_hex: []const u8,
        dst_hex: []const u8,
        src_port: u16,
        dst_port: u16,
        isn: u32,
        syn: ?Syn,
        /// Total client->server payload bytes (the whole TLS record for ClientHello fixtures).
        payload_len: u32,
        /// sha256 of the reassembled client payload == sha256 of `source_bin`; null when there is none.
        payload_sha256: ?[]const u8,
    };
};

pub fn parseExpected(gpa: std.mem.Allocator, json: []const u8) !std.json.Parsed(Expected) {
    return std.json.parseFromSlice(Expected, gpa, json, .{ .ignore_unknown_fields = true });
}
