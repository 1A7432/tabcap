//! Client-direction TCP payload reassembly for the simple case: in-order segments, no overlap, no gaps.
//! Enough to glue a ClientHello that spans two segments. Anything else is `error.Unsupported`
//! so that the caller sees it instead of silently corrupt data.
//! Spec: RFC 9293 Section 3.4 (sequence numbers; SYN occupies one sequence number, arithmetic is mod 2^32).
//! Rules: one unidirectional flow per (src, dst, src_port, dst_port). A SYN sets next_seq = ISN + 1 (and, if
//! it has no ACK, marks the client side and records window/options/TTL). A segment with payload
//! must start exactly at next_seq; segments without payload (pure ACK, FIN, keep-alive probes of length 0)
//! and RST segments are ignored. A flow first seen without its SYN starts at its first payload segment.
//! Oracle: fixtures/pcap/*.pcap from tools/mkpcap.py; the reassembled client payload's sha256 must equal the
//! sha256 of the original fixtures/clienthello/*.bin written into the JSON by the generator. The en0 fixture
//! splits the record 1400 + rest and wraps the sequence number past 2^32 between the two segments.
//! Reproduce: `python3 tools/mkpcap.py && zig build test`.
const std = @import("std");
const pcap = @import("../pcap.zig");
const eth_ip_tcp = @import("eth_ip_tcp.zig");

pub const Error = error{ Unsupported, OutOfMemory };

pub const FlowKey = struct {
    src: eth_ip_tcp.IpAddr,
    dst: eth_ip_tcp.IpAddr,
    src_port: u16,
    dst_port: u16,
};

pub const Flow = struct {
    key: FlowKey,
    /// Set when a SYN (without ACK) was seen from `key.src` -> this side is the client.
    saw_syn: bool,
    /// Sequence number of the next payload byte expected (null until a SYN or the first payload segment).
    next_seq: ?u32,
    /// Concatenated payload bytes in sequence order (owned).
    payload: std.ArrayList(u8),
    /// Copy of the first SYN's TCP header fields (window/options); options bytes are owned.
    syn: ?SynInfo,
};

pub const SynInfo = struct {
    window: u16,
    options: []const u8,
    ttl: u8,
};

pub const Reassembler = struct {
    gpa: std.mem.Allocator,
    /// Every flow seen. Invariant: flows that carry payload come first, ordered by their first payload
    /// byte; flows without payload (SYN-only, pure ACK directions) follow in first-seen order.
    flows: std.ArrayList(Flow),

    pub fn init(gpa: std.mem.Allocator) Reassembler {
        return .{ .gpa = gpa, .flows = .empty };
    }

    pub fn deinit(self: *Reassembler) void {
        for (self.flows.items) |*flow| {
            flow.payload.deinit(self.gpa);
            if (flow.syn) |syn| self.gpa.free(syn.options);
        }
        self.flows.deinit(self.gpa);
        self.* = undefined;
    }

    /// Appends the packet payload to its unidirectional flow (keyed by src/dst/ports).
    /// `error.Unsupported`: out-of-order, overlapping or retransmitted payload, or a SYN that contradicts
    /// the flow's ISN. Linear flow lookup: fine for the handful of flows in a fixture-sized capture.
    pub fn feed(self: *Reassembler, pkt: eth_ip_tcp.Packet) Error!void {
        const tcp = pkt.tcp;
        if (tcp.flags.rst) return; // RST data is diagnostic text, not stream bytes (RFC 9293 3.5.3)
        const index = try self.findOrAdd(.{
            .src = pkt.src,
            .dst = pkt.dst,
            .src_port = tcp.src_port,
            .dst_port = tcp.dst_port,
        });
        const flow = &self.flows.items[index];

        var data_seq = tcp.seq;
        if (tcp.flags.syn) {
            const after_syn = tcp.seq +% 1;
            if (flow.next_seq) |expected| {
                // Retransmitted SYN: harmless only if it repeats the ISN before any data was placed.
                if (expected != after_syn or flow.payload.items.len != 0) return error.Unsupported;
            } else {
                if (!tcp.flags.ack) {
                    const options = try self.gpa.dupe(u8, tcp.options);
                    flow.syn = .{ .window = tcp.window, .options = options, .ttl = pkt.ttl };
                    flow.saw_syn = true;
                }
                flow.next_seq = after_syn;
            }
            data_seq = after_syn; // TCP Fast Open data starts right after the SYN
        }
        if (pkt.payload.len == 0) return;

        const len = std.math.cast(u32, pkt.payload.len) orelse return error.Unsupported;
        if (flow.next_seq) |expected| {
            if (data_seq != expected) return error.Unsupported;
        }
        const first_payload = flow.payload.items.len == 0;
        try flow.payload.appendSlice(self.gpa, pkt.payload);
        flow.next_seq = data_seq +% len;
        if (first_payload) self.promote(index);
    }

    /// Flows that carried at least one payload byte, in the order their first payload byte arrived.
    pub fn flowsWithPayload(self: *const Reassembler) []const Flow {
        const items = self.flows.items;
        var n: usize = 0;
        while (n < items.len and items[n].payload.items.len != 0) n += 1;
        return items[0..n];
    }

    fn findOrAdd(self: *Reassembler, key: FlowKey) Error!usize {
        for (self.flows.items, 0..) |flow, i| {
            if (std.meta.eql(flow.key, key)) return i;
        }
        try self.flows.append(self.gpa, .{
            .key = key,
            .saw_syn = false,
            .next_seq = null,
            .payload = .empty,
            .syn = null,
        });
        return self.flows.items.len - 1;
    }

    /// Moves the flow at `index` (which just received its first payload) to the end of the payload prefix,
    /// keeping the relative order of everything else.
    fn promote(self: *Reassembler, index: usize) void {
        const items = self.flows.items;
        var k: usize = 0;
        while (k < index and items[k].payload.items.len != 0) k += 1;
        if (k == index) return;
        const moving = items[index];
        var j = index;
        while (j > k) : (j -= 1) items[j] = items[j - 1];
        items[k] = moving;
    }
};

/// The first client payload found in a capture, owned by the caller (`deinit`).
pub const ClientPayload = struct {
    key: FlowKey,
    payload: []u8,
    /// The flow's SYN, if the capture contains it; `options` is owned.
    syn: ?SynInfo,

    pub fn deinit(self: *ClientPayload, gpa: std.mem.Allocator) void {
        gpa.free(self.payload);
        if (self.syn) |syn| gpa.free(syn.options);
        self.* = undefined;
    }
};

pub const FirstPayloadError = pcap.ParseError || eth_ip_tcp.ParseError || Error || error{NoTlsPayload};

/// Reads the whole capture, reassembles every TCP flow and returns a copy of the first flow (by arrival of
/// its first payload byte) whose payload starts with 0x16 0x03 (TLS handshake record). ClientHello always
/// precedes ServerHello, so this is the client side. Non-TCP frames (`error.Unsupported` from the frame
/// parser) are skipped; every other error, including reassembly's `error.Unsupported`, is returned.
/// `error.NoTlsPayload` if no flow qualifies.
pub fn firstClientPayload(reader: *pcap.Reader, gpa: std.mem.Allocator) FirstPayloadError!ClientPayload {
    var reassembler = Reassembler.init(gpa);
    defer reassembler.deinit();
    while (try reader.next()) |record| {
        const pkt = eth_ip_tcp.parse(reader.header.link_type, record.data) catch |err| switch (err) {
            error.Unsupported => continue,
            else => |e| return e,
        };
        try reassembler.feed(pkt);
    }
    for (reassembler.flowsWithPayload()) |flow| {
        const bytes = flow.payload.items;
        if (bytes.len < 2 or bytes[0] != 0x16 or bytes[1] != 0x03) continue;
        const payload = try gpa.dupe(u8, bytes);
        errdefer gpa.free(payload);
        const syn: ?SynInfo = if (flow.syn) |s|
            .{ .window = s.window, .options = try gpa.dupe(u8, s.options), .ttl = s.ttl }
        else
            null;
        return .{ .key = flow.key, .payload = payload, .syn = syn };
    }
    return error.NoTlsPayload;
}

// ------------------------------------------------------------------------------------------------ tests

const testing = std.testing;
const fixtures = @import("fixtures");
const hex = @import("../hex.zig");
const Expected = fixtures.pcap.Expected;

fn expectAddr(expected_hex: []const u8, addr: eth_ip_tcp.IpAddr) !void {
    var buf: [32]u8 = undefined;
    const got = switch (addr) {
        .v4 => |a| hex.encode(&buf, &a),
        .v6 => |a| hex.encode(&buf, &a),
    };
    try testing.expectEqualStrings(expected_hex, got);
}

fn expectSyn(exp: Expected.Syn, syn: SynInfo) !void {
    try testing.expectEqual(exp.window, syn.window);
    try testing.expectEqual(exp.ttl, syn.ttl);
    var buf: [80]u8 = undefined;
    try testing.expectEqualStrings(exp.options_hex, hex.encode(&buf, syn.options));
}

fn sha256Hex(bytes: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    var out: [64]u8 = undefined;
    _ = hex.encode(&out, &digest);
    return out;
}

test "fixtures: first client payload == original .bin (sha256), 4-tuple and SYN match the generator" {
    const gpa = testing.allocator;
    for (fixtures.pcap.all) |fx| {
        errdefer std.debug.print("fixture {s}\n", .{fx.name});
        const parsed = try fixtures.pcap.parseExpected(gpa, fx.expected_json);
        defer parsed.deinit();
        const exp = parsed.value;
        var reader = try pcap.Reader.init(fx.bytes);
        const result = firstClientPayload(&reader, gpa);

        if (exp.trailing_error) |name| {
            if (result) |_| return error.TestExpectedError else |err| try testing.expectEqualStrings(name, @errorName(err));
            continue;
        }
        const client = exp.client orelse return error.TestUnexpectedResult;
        const want_sha = client.payload_sha256 orelse {
            try testing.expectError(error.NoTlsPayload, result);
            continue;
        };
        var cp = try result;
        defer cp.deinit(gpa);
        try testing.expectEqual(client.payload_len, cp.payload.len);
        try testing.expectEqualStrings(want_sha, &sha256Hex(cp.payload));
        try expectAddr(client.src_hex, cp.key.src);
        try expectAddr(client.dst_hex, cp.key.dst);
        try testing.expectEqual(client.src_port, cp.key.src_port);
        try testing.expectEqual(client.dst_port, cp.key.dst_port);
        try expectSyn(client.syn orelse return error.TestUnexpectedResult, cp.syn orelse return error.TestUnexpectedResult);
    }
}

test "fixture sanity: the two-segment ClientHello really wraps the sequence number" {
    const parsed = try fixtures.pcap.parseExpected(testing.allocator, fixtures.pcap.chrome_153_macos_en0_2seg.expected_json);
    defer parsed.deinit();
    var seqs: [2]u32 = undefined;
    var n: usize = 0;
    const client = parsed.value.client orelse return error.TestUnexpectedResult;
    for (parsed.value.records) |r| {
        const p = r.packet orelse continue;
        if (p.src_port != client.src_port or p.payload_len == 0) continue;
        if (n == seqs.len) return error.TestUnexpectedResult;
        seqs[n] = p.seq;
        n += 1;
    }
    try testing.expectEqual(@as(usize, 2), n);
    try testing.expect(seqs[1] < seqs[0]);
}

/// All TCP packets of a fixture in capture order (slices borrow the embedded bytes).
fn fixturePackets(fx: fixtures.pcap.Fixture, out: []eth_ip_tcp.Packet) ![]eth_ip_tcp.Packet {
    var reader = try pcap.Reader.init(fx.bytes);
    var n: usize = 0;
    while (try reader.next()) |record| {
        const pkt = eth_ip_tcp.parse(reader.header.link_type, record.data) catch |err| switch (err) {
            error.Unsupported => continue,
            else => |e| return e,
        };
        if (n == out.len) return error.TestUnexpectedResult;
        out[n] = pkt;
        n += 1;
    }
    return out[0..n];
}

test "syn-only: SynInfo recorded from the lone SYN, no flow with payload, NoTlsPayload" {
    const gpa = testing.allocator;
    const fx = fixtures.pcap.syn_only;
    const parsed = try fixtures.pcap.parseExpected(gpa, fx.expected_json);
    defer parsed.deinit();
    const client = parsed.value.client orelse return error.TestUnexpectedResult;

    var buf: [8]eth_ip_tcp.Packet = undefined;
    const pkts = try fixturePackets(fx, &buf);
    var ra = Reassembler.init(gpa);
    defer ra.deinit();
    for (pkts) |p| try ra.feed(p);
    try testing.expectEqual(@as(usize, 0), ra.flowsWithPayload().len);
    try testing.expectEqual(@as(usize, 1), ra.flows.items.len);
    const flow = ra.flows.items[0];
    try testing.expect(flow.saw_syn);
    try testing.expectEqual(@as(?u32, client.isn +% 1), flow.next_seq);
    const syn = flow.syn orelse return error.TestUnexpectedResult;
    try expectSyn(client.syn orelse return error.TestUnexpectedResult, syn);
    // The copy is owned: it must not alias the embedded capture.
    try testing.expect(@intFromPtr(syn.options.ptr) < @intFromPtr(fx.bytes.ptr) or
        @intFromPtr(syn.options.ptr) >= @intFromPtr(fx.bytes.ptr) + fx.bytes.len);

    var reader = try pcap.Reader.init(fx.bytes);
    try testing.expectError(error.NoTlsPayload, firstClientPayload(&reader, gpa));
}

test "reassembly order: flows by first payload; server SYN-ACK and pure ACKs do not disturb the client flow" {
    const gpa = testing.allocator;
    const fx = fixtures.pcap.chrome_153_macos_en0_2seg;
    var buf: [16]eth_ip_tcp.Packet = undefined;
    const pkts = try fixturePackets(fx, &buf);
    try testing.expectEqual(@as(usize, 6), pkts.len); // ARP and UDP skipped
    var ra = Reassembler.init(gpa);
    defer ra.deinit();
    for (pkts) |p| try ra.feed(p);
    try testing.expectEqual(@as(usize, 2), ra.flows.items.len);
    const with_payload = ra.flowsWithPayload();
    try testing.expectEqual(@as(usize, 1), with_payload.len);
    try testing.expect(with_payload[0].saw_syn);
    try testing.expect(!ra.flows.items[1].saw_syn); // the server side saw SYN+ACK only
    try testing.expectEqual(@as(?SynInfo, null), ra.flows.items[1].syn);
}

test "flowsWithPayload: ordered by first payload byte, not by first packet" {
    const gpa = testing.allocator;
    var buf: [8]eth_ip_tcp.Packet = undefined;
    const pkts = try fixturePackets(fixtures.pcap.chrome_153_macos_lo0_1seg, &buf);
    const syn, const synack, const hello = pkts[0..3].*;
    // A server->client segment that arrives before the ClientHello (flow created second, payload first).
    var banner = synack;
    banner.tcp.flags = .{ .fin = false, .syn = false, .rst = false, .psh = true, .ack = true, .urg = false, .ece = false, .cwr = false };
    banner.tcp.seq = synack.tcp.seq +% 1;
    banner.payload = "banner";
    // A third flow that never carries payload.
    var idle = syn;
    idle.tcp.src_port +%= 1;

    var ra = Reassembler.init(gpa);
    defer ra.deinit();
    for ([_]eth_ip_tcp.Packet{ syn, synack, idle, banner, hello }) |p| try ra.feed(p);
    const flows = ra.flowsWithPayload();
    try testing.expectEqual(@as(usize, 2), flows.len);
    try testing.expectEqualStrings("banner", flows[0].payload.items);
    try testing.expectEqualSlices(u8, hello.payload, flows[1].payload.items);
    try testing.expect(flows[1].saw_syn);
    // The idle flow is still tracked, after the payload prefix.
    try testing.expectEqual(@as(usize, 3), ra.flows.items.len);
    try testing.expectEqual(idle.tcp.src_port, ra.flows.items[2].key.src_port);
    try testing.expectEqual(@as(usize, 0), ra.flows.items[2].payload.items.len);
}

test "out-of-order, retransmitted and ISN-contradicting segments are Unsupported" {
    const gpa = testing.allocator;
    var buf: [16]eth_ip_tcp.Packet = undefined;
    const pkts = try fixturePackets(fixtures.pcap.chrome_153_macos_en0_2seg, &buf);
    // Capture order after skipping ARP/UDP: SYN, SYN-ACK, ACK, part 1, server ACK, part 2.
    const syn, const synack, const ack, const part1, const server_ack, const part2 = pkts[0..6].*;
    try testing.expect(part1.payload.len == 1400 and part2.payload.len > 0);

    {
        var ra = Reassembler.init(gpa);
        defer ra.deinit();
        for ([_]eth_ip_tcp.Packet{ syn, synack, ack, server_ack }) |p| try ra.feed(p);
        try testing.expectError(error.Unsupported, ra.feed(part2)); // gap: part 1 missing
    }
    {
        var ra = Reassembler.init(gpa);
        defer ra.deinit();
        for ([_]eth_ip_tcp.Packet{ syn, synack, ack, part1 }) |p| try ra.feed(p);
        try testing.expectError(error.Unsupported, ra.feed(part1)); // retransmission / overlap
    }
    {
        var ra = Reassembler.init(gpa);
        defer ra.deinit();
        try ra.feed(syn);
        try ra.feed(syn); // retransmitted SYN with the same ISN is fine
        var other = syn;
        other.tcp.seq +%= 1000;
        try testing.expectError(error.Unsupported, ra.feed(other));
    }
    {
        // Capture started after the handshake: the flow starts at its first payload segment, no SynInfo.
        var ra = Reassembler.init(gpa);
        defer ra.deinit();
        for ([_]eth_ip_tcp.Packet{ part1, server_ack, part2 }) |p| try ra.feed(p);
        const flows = ra.flowsWithPayload();
        try testing.expectEqual(@as(usize, 1), flows.len);
        try testing.expectEqual(part1.payload.len + part2.payload.len, flows[0].payload.items.len);
        try testing.expectEqual(@as(?SynInfo, null), flows[0].syn);
        try testing.expect(!flows[0].saw_syn);
    }
    {
        // RST segments are ignored even when they carry bytes.
        var ra = Reassembler.init(gpa);
        defer ra.deinit();
        var rst = part1;
        rst.tcp.flags.rst = true;
        try ra.feed(rst);
        try testing.expectEqual(@as(usize, 0), ra.flowsWithPayload().len);
    }
}

fn firstPayloadAllocCheck(gpa: std.mem.Allocator, bytes: []const u8) !void {
    var reader = try pcap.Reader.init(bytes);
    var cp = try firstClientPayload(&reader, gpa);
    cp.deinit(gpa);
}

test "firstClientPayload frees everything on every allocation failure" {
    try testing.checkAllAllocationFailures(testing.allocator, firstPayloadAllocCheck, .{fixtures.pcap.chrome_153_macos_en0_2seg.bytes});
    try testing.checkAllAllocationFailures(testing.allocator, firstPayloadAllocCheck, .{fixtures.pcap.firefox_157b4_macos_v6_1seg.bytes});
}
