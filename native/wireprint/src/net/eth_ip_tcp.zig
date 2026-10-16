//! Minimal Ethernet / DLT_NULL -> IPv4 / IPv6 -> TCP parser for pcap records.
//! Only what fingerprinting needs: 4-tuple, seq/ack, flags, window, raw TCP options, payload, IP TTL/hop limit.
//! Specs: IEEE 802.3 (14-byte header, ethertype 0800/86dd, 8100/88a8 VLAN tags), RFC 791 (IPv4),
//! RFC 8200 (IPv6, extension headers Section 4), RFC 9293 (TCP header Section 3.1, options).
//! DLT_NULL (macOS lo0): 4-byte protocol family in HOST byte order of the capturing machine; 2 = AF_INET,
//! 24/28/30 = AF_INET6 (https://www.tcpdump.org/linktypes/LINKTYPE_NULL.html); both byte orders are tried.
//! IPv6 extension headers 0 (Hop-by-Hop), 43 (Routing), 60 (Destination Options) are walked by Next Header
//! until 6 (TCP); fragments (IPv4 MF/offset, IPv6 header 44) are not reassembled (error.Unsupported).
//! IPv4 total length 0 is treated as "use the captured length", matching Wireshark's TSO heuristic.
//! Error discipline: bytes missing from the slice being parsed -> error.Truncated; fields that contradict
//! each other -> error.Malformed; well-formed but not IP/TCP (ARP, UDP, fragments...) -> error.Unsupported.
//! Oracle: fixtures/pcap/*.pcap + *.expected.json built by tools/mkpcap.py from the header values it wrote
//! (cross-checked with `tcpdump -r <file> -nn -vv`, which reports every TCP checksum as correct).
//! Reproduce: `python3 tools/mkpcap.py && zig build test`.
const std = @import("std");
const pcap = @import("../pcap.zig");

pub const ParseError = error{ Truncated, Malformed, Unsupported };

pub const IpAddr = union(enum) {
    v4: [4]u8,
    v6: [16]u8,
};

pub const TcpFlags = packed struct(u8) {
    fin: bool,
    syn: bool,
    rst: bool,
    psh: bool,
    ack: bool,
    urg: bool,
    ece: bool,
    cwr: bool,
};

pub const TcpHeader = struct {
    src_port: u16,
    dst_port: u16,
    seq: u32,
    ack: u32,
    data_offset: u8, // in 32-bit words (5..15)
    flags: TcpFlags,
    window: u16,
    /// Raw option bytes (data_offset*4 - 20), original order. Iterate with `TcpOptionIterator`.
    options: []const u8,
};

pub const TcpOption = struct {
    kind: u8,
    /// Option data (without kind/length bytes); empty for EOL (0) and NOP (1).
    data: []const u8,
};

pub const tcp_option = struct {
    pub const eol: u8 = 0;
    pub const nop: u8 = 1;
    pub const mss: u8 = 2;
    pub const window_scale: u8 = 3;
    pub const sack_permitted: u8 = 4;
    pub const timestamps: u8 = 8;
};

/// Iterates TCP options in wire order. Stops after EOL (kind 0); bytes after EOL are NOT visited
/// (callers that want to count every trailing zero byte must scan `options` themselves).
/// Every kind other than EOL/NOP must carry a length byte that counts kind and length (>= 2).
pub const TcpOptionIterator = struct {
    bytes: []const u8,
    pos: usize = 0,

    pub fn next(self: *TcpOptionIterator) ParseError!?TcpOption {
        if (self.pos >= self.bytes.len) return null;
        const rest = self.bytes[self.pos..];
        const kind = rest[0];
        switch (kind) {
            tcp_option.eol => {
                self.pos = self.bytes.len; // end of option list: ignore whatever follows
                return .{ .kind = kind, .data = rest[0..0] };
            },
            tcp_option.nop => {
                self.pos += 1;
                return .{ .kind = kind, .data = rest[1..1] };
            },
            else => {
                if (rest.len < 2) return error.Truncated;
                const len = rest[1];
                if (len < 2) return error.Malformed;
                if (rest.len < len) return error.Truncated;
                self.pos += len;
                return .{ .kind = kind, .data = rest[2..len] };
            },
        }
    }
};

pub const Packet = struct {
    src: IpAddr,
    dst: IpAddr,
    /// IPv4 TTL or IPv6 hop limit.
    ttl: u8,
    tcp: TcpHeader,
    payload: []const u8,
};

/// Parses one link-layer frame. Non-IP or non-TCP frames are `error.Unsupported` (callers skip them).
/// Supported link types: DLT_NULL and Ethernet; everything else is `error.Unsupported`.
pub fn parse(link: pcap.LinkType, frame: []const u8) ParseError!Packet {
    return switch (link) {
        .null => parseNull(frame),
        .ethernet => parseEthernet(frame),
        else => error.Unsupported,
    };
}

const IpVersion = enum { v4, v6 };

fn nullFamily(af: u32) ?IpVersion {
    return switch (af) {
        2 => .v4, // AF_INET everywhere
        24, 28, 30 => .v6, // AF_INET6 on NetBSD/OpenBSD, FreeBSD, macOS
        else => null,
    };
}

fn parseNull(frame: []const u8) ParseError!Packet {
    if (frame.len < 4) return error.Truncated;
    const af = frame[0..4];
    // The capturing host wrote its own byte order; the small AF values cannot collide across orders.
    const version = nullFamily(std.mem.readInt(u32, af, .little)) orelse
        nullFamily(std.mem.readInt(u32, af, .big)) orelse
        return error.Unsupported;
    return parseIp(version, frame[4..]);
}

const ethertype_ipv4 = 0x0800;
const ethertype_ipv6 = 0x86dd;
const ethertype_vlan = 0x8100; // IEEE 802.1Q
const ethertype_qinq = 0x88a8; // IEEE 802.1ad
const max_vlan_tags = 2;

fn parseEthernet(frame: []const u8) ParseError!Packet {
    // dst MAC (6), src MAC (6), ethertype (2); each VLAN tag inserts 4 bytes before the real ethertype.
    var type_off: usize = 12;
    var tags: usize = 0;
    while (true) {
        if (frame.len < type_off + 2) return error.Truncated;
        const ethertype = std.mem.readInt(u16, frame[type_off..][0..2], .big);
        const body = frame[type_off + 2 ..];
        switch (ethertype) {
            ethertype_ipv4 => return parseIp(.v4, body),
            ethertype_ipv6 => return parseIp(.v6, body),
            ethertype_vlan, ethertype_qinq => {
                if (tags == max_vlan_tags) return error.Unsupported;
                tags += 1;
                type_off += 4;
            },
            else => return error.Unsupported, // ARP, LLC length field, ...
        }
    }
}

fn parseIp(version: IpVersion, ip: []const u8) ParseError!Packet {
    return switch (version) {
        .v4 => parseIpv4(ip),
        .v6 => parseIpv6(ip),
    };
}

const ip_proto_tcp = 6;

fn parseIpv4(ip: []const u8) ParseError!Packet {
    if (ip.len < 20) return error.Truncated;
    if (ip[0] >> 4 != 4) return error.Malformed;
    const ihl = @as(usize, ip[0] & 0x0f) * 4;
    if (ihl < 20) return error.Malformed;
    if (ip.len < ihl) return error.Truncated;
    const total_field = std.mem.readInt(u16, ip[2..4], .big);
    // Total length 0: the NIC segments later (TSO) and the stack left it unset; Wireshark then uses the
    // captured length. Otherwise bytes after total length are link-layer padding and are dropped.
    const total: usize = if (total_field == 0) ip.len else total_field;
    if (total < ihl) return error.Malformed;
    if (ip.len < total) return error.Truncated;
    const frag = std.mem.readInt(u16, ip[6..8], .big);
    const more_fragments = frag & 0x2000 != 0;
    const frag_offset = frag & 0x1fff;
    if (more_fragments or frag_offset != 0) return error.Unsupported;
    if (ip[9] != ip_proto_tcp) return error.Unsupported;
    const seg = try parseTcp(ip[ihl..total]);
    return .{
        .src = .{ .v4 = ip[12..16].* },
        .dst = .{ .v4 = ip[16..20].* },
        .ttl = ip[8],
        .tcp = seg.header,
        .payload = seg.payload,
    };
}

const ipv6_header_len = 40;

fn parseIpv6(ip: []const u8) ParseError!Packet {
    if (ip.len < ipv6_header_len) return error.Truncated;
    if (ip[0] >> 4 != 6) return error.Malformed;
    const payload_len = std.mem.readInt(u16, ip[4..6], .big);
    if (payload_len == 0) return error.Unsupported; // jumbogram (RFC 2675) or unset length
    const end = ipv6_header_len + @as(usize, payload_len);
    if (ip.len < end) return error.Truncated;
    const pkt = ip[0..end]; // drop link-layer padding

    var next_header = ip[6];
    var off: usize = ipv6_header_len;
    while (next_header != ip_proto_tcp) {
        switch (next_header) {
            // Hop-by-Hop, Routing, Destination Options share the layout: Next Header, Hdr Ext Len in
            // 8-octet units not counting the first 8 octets (RFC 8200 Sections 4.3, 4.4, 4.6).
            0, 43, 60 => {
                // RFC 8200 Section 4.1: Hop-by-Hop may only appear immediately after the IPv6 header.
                if (next_header == 0 and off != ipv6_header_len) return error.Malformed;
                if (pkt.len - off < 2) return error.Truncated;
                const ext_len = (@as(usize, pkt[off + 1]) + 1) * 8;
                if (pkt.len - off < ext_len) return error.Truncated;
                next_header = pkt[off];
                off += ext_len;
            },
            44 => return error.Unsupported, // Fragment header: no reassembly
            else => return error.Unsupported, // UDP, ICMPv6, ESP/AH, No Next Header, ...
        }
    }
    const seg = try parseTcp(pkt[off..]);
    return .{
        .src = .{ .v6 = ip[8..24].* },
        .dst = .{ .v6 = ip[24..40].* },
        .ttl = ip[7],
        .tcp = seg.header,
        .payload = seg.payload,
    };
}

const Segment = struct { header: TcpHeader, payload: []const u8 };

fn parseTcp(seg: []const u8) ParseError!Segment {
    if (seg.len < 20) return error.Truncated;
    const data_offset = seg[12] >> 4;
    if (data_offset < 5) return error.Malformed;
    const header_len = @as(usize, data_offset) * 4;
    if (seg.len < header_len) return error.Truncated;
    return .{
        .header = .{
            .src_port = std.mem.readInt(u16, seg[0..2], .big),
            .dst_port = std.mem.readInt(u16, seg[2..4], .big),
            .seq = std.mem.readInt(u32, seg[4..8], .big),
            .ack = std.mem.readInt(u32, seg[8..12], .big),
            .data_offset = data_offset,
            .flags = @bitCast(seg[13]),
            .window = std.mem.readInt(u16, seg[14..16], .big),
            .options = seg[20..header_len],
        },
        .payload = seg[header_len..],
    };
}

// ------------------------------------------------------------------------------------------------ tests

const testing = std.testing;
const fixtures = @import("fixtures");
const hex = @import("../hex.zig");
const Expected = fixtures.pcap.Expected;

fn expectErrorName(name: []const u8, result: anytype) !void {
    if (result) |_| {
        std.debug.print("expected error.{s}, got a value\n", .{name});
        return error.TestExpectedError;
    } else |err| try testing.expectEqualStrings(name, @errorName(err));
}

fn expectAddr(expected_hex: []const u8, addr: IpAddr) !void {
    var buf: [32]u8 = undefined;
    const got = switch (addr) {
        .v4 => |a| hex.encode(&buf, &a),
        .v6 => |a| hex.encode(&buf, &a),
    };
    try testing.expectEqualStrings(expected_hex, got);
}

/// Walks the options with the iterator and compares kinds, MSS and window scale with the generator's list.
fn expectOptions(options: []const u8, kinds: []const u16, mss: ?u16, wscale: ?u8) !void {
    var it: TcpOptionIterator = .{ .bytes = options };
    var got_mss: ?u16 = null;
    var got_wscale: ?u8 = null;
    var i: usize = 0;
    while (try it.next()) |opt| : (i += 1) {
        if (i >= kinds.len) return error.TestUnexpectedResult;
        try testing.expectEqual(kinds[i], opt.kind);
        switch (opt.kind) {
            tcp_option.mss => {
                try testing.expectEqual(@as(usize, 2), opt.data.len);
                got_mss = std.mem.readInt(u16, opt.data[0..2], .big);
            },
            tcp_option.window_scale => {
                try testing.expectEqual(@as(usize, 1), opt.data.len);
                got_wscale = opt.data[0];
            },
            else => {},
        }
    }
    try testing.expectEqual(kinds.len, i);
    try testing.expectEqual(mss, got_mss);
    try testing.expectEqual(wscale, got_wscale);
}

fn expectPacket(ep: Expected.Packet, frame: []const u8, pkt: Packet) !void {
    try testing.expectEqual(ep.ip_version, @as(u8, switch (pkt.src) {
        .v4 => 4,
        .v6 => 6,
    }));
    try expectAddr(ep.src_hex, pkt.src);
    try expectAddr(ep.dst_hex, pkt.dst);
    try testing.expectEqual(ep.ttl, pkt.ttl);
    try testing.expectEqual(ep.src_port, pkt.tcp.src_port);
    try testing.expectEqual(ep.dst_port, pkt.tcp.dst_port);
    try testing.expectEqual(ep.seq, pkt.tcp.seq);
    try testing.expectEqual(ep.ack, pkt.tcp.ack);
    try testing.expectEqual(ep.data_offset, pkt.tcp.data_offset);
    try testing.expectEqual(ep.flags, @as(u8, @bitCast(pkt.tcp.flags)));
    try testing.expectEqual(ep.window, pkt.tcp.window);
    var opt_hex: [80]u8 = undefined;
    try testing.expectEqualStrings(ep.options_hex, hex.encode(&opt_hex, pkt.tcp.options));
    try expectOptions(pkt.tcp.options, ep.option_kinds, ep.mss, ep.wscale);
    try testing.expectEqual(ep.payload_len, pkt.payload.len);
    // Zero-copy: the payload is the tail of the IP packet inside the frame (link padding excluded).
    const ip_end = ep.link_header_len + ep.ip_len;
    try testing.expectEqual(@intFromPtr(frame.ptr) + ip_end, @intFromPtr(pkt.payload.ptr) + pkt.payload.len);
}

test "fixtures: every record parses to the generator's header values (DLT_NULL, Ethernet, IPv4, IPv6)" {
    const gpa = testing.allocator;
    for (fixtures.pcap.all) |fx| {
        errdefer std.debug.print("fixture {s}\n", .{fx.name});
        const parsed = try fixtures.pcap.parseExpected(gpa, fx.expected_json);
        defer parsed.deinit();
        var r = try pcap.Reader.init(fx.bytes);
        try testing.expectEqual(parsed.value.linktype, @intFromEnum(r.header.link_type));
        for (parsed.value.records) |er| {
            errdefer std.debug.print("record {d}\n", .{er.index});
            const rec = (try r.next()) orelse return error.TestUnexpectedResult;
            const result = parse(r.header.link_type, rec.data);
            if (er.parse_error) |name| {
                try expectErrorName(name, result);
                continue;
            }
            try expectPacket(er.packet orelse return error.TestUnexpectedResult, rec.data, try result);
        }
    }
}

test "fixtures: every strict prefix of an IP packet is Truncated; link padding is not payload" {
    const gpa = testing.allocator;
    for (fixtures.pcap.all) |fx| {
        errdefer std.debug.print("fixture {s}\n", .{fx.name});
        const parsed = try fixtures.pcap.parseExpected(gpa, fx.expected_json);
        defer parsed.deinit();
        var r = try pcap.Reader.init(fx.bytes);
        for (parsed.value.records) |er| {
            const rec = (try r.next()) orelse return error.TestUnexpectedResult;
            const ep = er.packet orelse continue;
            const ip_end = ep.link_header_len + ep.ip_len;
            for (0..ip_end) |cut| {
                errdefer std.debug.print("record {d} cut {d}\n", .{ er.index, cut });
                try testing.expectError(error.Truncated, parse(r.header.link_type, rec.data[0..cut]));
            }
            // From the end of the IP packet on, trailing (padding) bytes change nothing.
            for (ip_end..rec.data.len + 1) |cut| {
                const pkt = try parse(r.header.link_type, rec.data[0..cut]);
                try testing.expectEqual(ep.payload_len, pkt.payload.len);
            }
        }
    }
}

/// Record `index` of a fixture, plus its expectations (caller deinits `parsed`).
fn fixtureRecord(fx: fixtures.pcap.Fixture, index: usize) !struct { data: []const u8, parsed: std.json.Parsed(Expected), link: pcap.LinkType } {
    const parsed = try fixtures.pcap.parseExpected(testing.allocator, fx.expected_json);
    errdefer parsed.deinit();
    var r = try pcap.Reader.init(fx.bytes);
    var i: usize = 0;
    while (try r.next()) |rec| : (i += 1) {
        if (i == index) return .{ .data = rec.data, .parsed = parsed, .link = r.header.link_type };
    }
    return error.TestUnexpectedResult;
}

test "DLT_NULL: AF_INET6 values 24/28/30 in either byte order; unknown family is Unsupported" {
    // The v6 fixture's data packet (Hop-by-Hop -> Destination Options -> TCP), re-framed for DLT_NULL.
    const fx = try fixtureRecord(fixtures.pcap.firefox_157b4_macos_v6_1seg, 2);
    defer fx.parsed.deinit();
    const ep = fx.parsed.value.records[2].packet orelse return error.TestUnexpectedResult;
    try testing.expectEqual(@as(usize, 2), ep.ip_ext_headers.len);
    const ip = fx.data[ep.link_header_len..];
    const buf = try testing.allocator.alloc(u8, 4 + ip.len);
    defer testing.allocator.free(buf);
    @memcpy(buf[4..], ip);
    for ([_]u32{ 24, 28, 30 }) |af| {
        for ([_]std.builtin.Endian{ .little, .big }) |endian| {
            std.mem.writeInt(u32, buf[0..4], af, endian);
            const pkt = try parse(.null, buf);
            try expectAddr(ep.src_hex, pkt.src);
            try expectAddr(ep.dst_hex, pkt.dst);
            try testing.expectEqual(ep.seq, pkt.tcp.seq);
            try testing.expectEqual(ep.payload_len, pkt.payload.len);
        }
    }
    std.mem.writeInt(u32, buf[0..4], 17, .little);
    try testing.expectError(error.Unsupported, parse(.null, buf));
    // AF_INET header in front of an IPv6 packet: the version nibble contradicts the family.
    std.mem.writeInt(u32, buf[0..4], 2, .little);
    try testing.expectError(error.Malformed, parse(.null, buf));
    // Link types this parser does not handle.
    try testing.expectError(error.Unsupported, parse(.linux_sll, buf));
    try testing.expectError(error.Unsupported, parse(@enumFromInt(147), buf));
}

test "Ethernet: 802.1Q / 802.1ad tags are skipped; a third tag is Unsupported" {
    const fx = try fixtureRecord(fixtures.pcap.chrome_153_macos_en0_2seg, 2); // client SYN
    defer fx.parsed.deinit();
    const ep = fx.parsed.value.records[2].packet orelse return error.TestUnexpectedResult;
    const tag_q = [_]u8{ 0x81, 0x00, 0x00, 0x64 }; // VLAN 100
    const tag_ad = [_]u8{ 0x88, 0xa8, 0x00, 0xc8 }; // S-VLAN 200
    const buf = try testing.allocator.alloc(u8, fx.data.len + 12);
    defer testing.allocator.free(buf);

    @memcpy(buf[0..12], fx.data[0..12]);
    @memcpy(buf[12..16], &tag_q);
    @memcpy(buf[16 .. fx.data.len + 4], fx.data[12..]);
    try expectPacket(ep, buf[4 .. fx.data.len + 4], try parse(.ethernet, buf[0 .. fx.data.len + 4]));

    @memcpy(buf[12..16], &tag_ad);
    @memcpy(buf[16..20], &tag_q);
    @memcpy(buf[20 .. fx.data.len + 8], fx.data[12..]);
    try expectPacket(ep, buf[8 .. fx.data.len + 8], try parse(.ethernet, buf[0 .. fx.data.len + 8]));

    @memcpy(buf[12..16], &tag_ad);
    @memcpy(buf[16..20], &tag_q);
    @memcpy(buf[20..24], &tag_q);
    @memcpy(buf[24..], fx.data[12..]);
    try testing.expectError(error.Unsupported, parse(.ethernet, buf));
}

test "IPv4 mutations: fragments and non-TCP are Unsupported; contradictions are Malformed; TSO length 0" {
    const fx = try fixtureRecord(fixtures.pcap.chrome_153_macos_lo0_1seg, 2); // ClientHello segment
    defer fx.parsed.deinit();
    const ep = fx.parsed.value.records[2].packet orelse return error.TestUnexpectedResult;
    const buf = try testing.allocator.dupe(u8, fx.data);
    defer testing.allocator.free(buf);
    const ip = buf[4..];
    const orig = try testing.allocator.dupe(u8, buf);
    defer testing.allocator.free(orig);

    ip[6] |= 0x20; // More Fragments
    try testing.expectError(error.Unsupported, parse(.null, buf));
    @memcpy(buf, orig);
    ip[7] = 0x10; // fragment offset != 0
    try testing.expectError(error.Unsupported, parse(.null, buf));
    @memcpy(buf, orig);
    ip[9] = 17; // UDP
    try testing.expectError(error.Unsupported, parse(.null, buf));
    @memcpy(buf, orig);
    ip[0] = 0x44; // IHL 4 words < 20 bytes
    try testing.expectError(error.Malformed, parse(.null, buf));
    @memcpy(buf, orig);
    ip[0] = 0x65; // version 6 behind AF_INET
    try testing.expectError(error.Malformed, parse(.null, buf));
    @memcpy(buf, orig);
    std.mem.writeInt(u16, ip[2..4], 19, .big); // total length shorter than the header
    try testing.expectError(error.Malformed, parse(.null, buf));
    @memcpy(buf, orig);
    ip[20 + 12] = 0x40; // TCP data offset 4 words
    try testing.expectError(error.Malformed, parse(.null, buf));
    @memcpy(buf, orig);
    std.mem.writeInt(u16, ip[2..4], 20 + 32, .big); // IP packet ends right after the 32-byte TCP header
    const short = try parse(.null, buf);
    try testing.expectEqual(@as(usize, 0), short.payload.len);
    std.mem.writeInt(u16, ip[2..4], 20 + 30, .big); // TCP header (32 bytes) does not fit in 30
    try testing.expectError(error.Truncated, parse(.null, buf));
    @memcpy(buf, orig);
    std.mem.writeInt(u16, ip[2..4], 0, .big); // TSO: fall back to the captured length
    const tso = try parse(.null, buf);
    try testing.expectEqual(ep.payload_len, tso.payload.len);
}

test "IPv6 mutations: Fragment header Unsupported, Hop-by-Hop not first Malformed, ext header overrun Truncated" {
    const fx = try fixtureRecord(fixtures.pcap.firefox_157b4_macos_v6_1seg, 2);
    defer fx.parsed.deinit();
    const ep = fx.parsed.value.records[2].packet orelse return error.TestUnexpectedResult;
    // Generator chain: IPv6 -> Hop-by-Hop (0, 8 bytes) -> Destination Options (60, 16 bytes) -> TCP.
    try testing.expectEqualSlices(u16, &.{ 0, 60 }, ep.ip_ext_headers);
    const buf = try testing.allocator.dupe(u8, fx.data);
    defer testing.allocator.free(buf);
    const orig = try testing.allocator.dupe(u8, buf);
    defer testing.allocator.free(orig);
    const ip = buf[ep.link_header_len..];

    ip[6] = 44; // Fragment
    try testing.expectError(error.Unsupported, parse(.ethernet, buf));
    @memcpy(buf, orig);
    ip[40] = 44; // Hop-by-Hop -> Fragment
    try testing.expectError(error.Unsupported, parse(.ethernet, buf));
    @memcpy(buf, orig);
    ip[40 + 8] = 17; // Destination Options -> UDP
    try testing.expectError(error.Unsupported, parse(.ethernet, buf));
    @memcpy(buf, orig);
    ip[6] = 60; // chain becomes Destination Options -> Hop-by-Hop (second position)
    ip[40] = 0;
    try testing.expectError(error.Malformed, parse(.ethernet, buf));
    @memcpy(buf, orig);
    ip[40 + 1] = 255; // Hop-by-Hop claims 2048 bytes
    try testing.expectError(error.Truncated, parse(.ethernet, buf));
    @memcpy(buf, orig);
    std.mem.writeInt(u16, ip[4..6], 0, .big); // jumbogram marker
    try testing.expectError(error.Unsupported, parse(.ethernet, buf));
    @memcpy(buf, orig);
    ip[0] = 0x40; // version 4 behind ethertype 86dd
    try testing.expectError(error.Malformed, parse(.ethernet, buf));
}

test "TcpOptionIterator: EOL stops, NOP has no length, length < 2 Malformed, overrun Truncated" {
    const Case = struct { bytes: []const u8, kinds: []const u8, err: ?ParseError };
    const cases = [_]Case{
        .{ .bytes = &.{}, .kinds = &.{}, .err = null },
        .{ .bytes = &.{ 1, 1, 0, 2, 4, 5, 0xb4 }, .kinds = &.{ 1, 1, 0 }, .err = null }, // bytes after EOL ignored
        .{ .bytes = &.{ 3, 3, 6, 1 }, .kinds = &.{ 3, 1 }, .err = null },
        .{ .bytes = &.{ 254, 2 }, .kinds = &.{254}, .err = null }, // unknown kind with empty data
        .{ .bytes = &.{ 1, 2 }, .kinds = &.{1}, .err = error.Truncated }, // MSS without length byte
        .{ .bytes = &.{ 2, 4, 5 }, .kinds = &.{}, .err = error.Truncated }, // MSS cut short
        .{ .bytes = &.{ 2, 1, 0, 0 }, .kinds = &.{}, .err = error.Malformed },
        .{ .bytes = &.{ 1, 8, 0, 0 }, .kinds = &.{1}, .err = error.Malformed }, // len 0 would loop forever
    };
    for (cases) |c| {
        var it: TcpOptionIterator = .{ .bytes = c.bytes };
        var got: [8]u8 = undefined;
        var n: usize = 0;
        const end: ?ParseError = while (true) {
            const opt = it.next() catch |err| break err;
            const o = opt orelse break null;
            got[n] = o.kind;
            n += 1;
        };
        try testing.expectEqualSlices(u8, c.kinds, got[0..n]);
        try testing.expectEqual(c.err, end);
    }
    var ws: TcpOptionIterator = .{ .bytes = &.{ 3, 3, 6 } };
    const opt = (try ws.next()) orelse return error.TestUnexpectedResult;
    try testing.expectEqualSlices(u8, &.{6}, opt.data);
}
