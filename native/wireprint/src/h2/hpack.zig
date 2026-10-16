//! HPACK decoder (RFC 7541; https://www.rfc-editor.org/rfc/rfc7541.txt).
//!   - integer representation with N-bit prefix (5.1)
//!   - string literals, raw or Huffman-coded (5.2, Appendix B table in huffman_table.zig)
//!   - static table (Appendix A, static_table.zig) + dynamic table with size accounting (4.1, entry = 32 + lens)
//!   - indexed (6.1), literal with incremental indexing (6.2.1), without indexing (6.2.2), never indexed
//!     (6.2.3), dynamic table size update (6.3)
//! Header order is preserved exactly as decoded; the fingerprint layer depends on it.
//! Oracle: fixtures/hpack/c*.hex + c*.json (RFC 7541 Appendix C.2–C.6, including dynamic table state after
//! each block), see fixtures/hpack/README.md; integer examples C.1 from spec/test-vectors.json.
//! Reproduce: `zig build test` (the fixture test walks all 16 blocks along their `continues_from` chains).
//! Decoding errors are `error.Malformed`/`error.Truncated`. RFC 9113 §4.3 makes any decoding error a
//! connection error (COMPRESSION_ERROR): after an error the Decoder's table state is undefined relative to
//! the peer's encoder, so the connection must be torn down, not the block retried.
const std = @import("std");
const huffman_table = @import("huffman_table.zig");
const static_table = @import("static_table.zig");

pub const DecodeError = error{ Truncated, Malformed, OutOfMemory };

pub const Header = struct {
    name: []const u8,
    value: []const u8,
    /// True for literal-never-indexed representations (RFC 7541 6.2.3).
    sensitive: bool = false,
};

/// Per-entry overhead in the size accounting (RFC 7541 §4.1): "The size of an entry is the sum of its
/// name's length in octets, its value's length in octets, and 32."
pub const entry_overhead = 32;

fn entrySize(name_len: usize, value_len: usize) u64 {
    return @as(u64, entry_overhead) + name_len + value_len;
}

pub const Decoder = struct {
    gpa: std.mem.Allocator,
    /// Protocol limit (RFC 7541 §4.2): the SETTINGS_HEADER_TABLE_SIZE this endpoint advertised and the
    /// peer acknowledged (RFC 9113 §4.3.1). The encoder may never choose a larger table.
    max_table_size: u32,
    /// The dynamic table's current maximum size, chosen by the peer's encoder with a Dynamic Table Size
    /// Update (§6.3); always <= `max_table_size`. Starts equal to it (RFC 9113 §4.3.1: both sides start at
    /// the initial SETTINGS value).
    capacity: u32,
    /// Sum of entry sizes (§4.1); always <= `capacity`.
    size: u32 = 0,
    /// Newest entry first: `entries.items[0]` is index 62 (§2.3.3 "Insertion Point"), the last item is the
    /// oldest and is the first to be evicted (§4.4 "Dropping Point"). Names/values are owned by `gpa`.
    entries: std.ArrayList(Header) = .empty,
    /// Set when `setMaxTableSize` drops the limit below the current table size: RFC 9113 §4.3.1 then
    /// requires the next header block to start with a Dynamic Table Size Update.
    size_update_required: bool = false,

    /// `max_table_size` is the SETTINGS_HEADER_TABLE_SIZE in effect (4096 by default, RFC 9113 6.5.2).
    pub fn init(gpa: std.mem.Allocator, max_table_size: u32) Decoder {
        return .{ .gpa = gpa, .max_table_size = max_table_size, .capacity = max_table_size };
    }

    pub fn deinit(self: *Decoder) void {
        for (self.entries.items) |e| self.freeEntry(e);
        self.entries.deinit(self.gpa);
        self.* = undefined;
    }

    /// Called when the SETTINGS_HEADER_TABLE_SIZE this decoder advertised is acknowledged by the peer
    /// (RFC 9113 §6.5.2 names the decoder side as the one that sets it). Evicts if needed.
    ///
    /// A lower limit clamps `capacity` at once and evicts (§4.3). If the new limit is below the current
    /// table size, RFC 9113 §4.3.1 obliges the encoder to open its next block with a size update, and we
    /// enforce that. A higher limit leaves `capacity` alone: the encoder has to announce a bigger table
    /// with a size update before it may use it (§4.2 "A change in the maximum size of the dynamic table is
    /// signaled via a dynamic table size update").
    pub fn setMaxTableSize(self: *Decoder, size: u32) void {
        if (size < self.size) self.size_update_required = true;
        self.max_table_size = size;
        if (self.capacity > size) {
            self.capacity = size;
            self.evictUntilFits(0);
        }
    }

    /// Decodes one complete header block (HEADERS fragment + CONTINUATIONs concatenated). Decoded names
    /// and values are copied into `arena` (they must outlive dynamic-table evictions); appended to `out`.
    /// `out` itself also grows with `arena`. Names/values of static-table hits borrow the static table's
    /// string constants (static lifetime) instead of being copied.
    pub fn decodeBlock(self: *Decoder, block: []const u8, arena: std.mem.Allocator, out: *std.ArrayList(Header)) DecodeError!void {
        var cur: Cursor = .{ .bytes = block };
        // §4.2: a size update "MUST occur at the beginning of the first header block following the change";
        // once a field representation has been seen, a size update is out of place.
        var at_block_start = true;

        if (self.size_update_required) {
            if (block.len == 0 or block[0] & 0xe0 != 0x20) return error.Malformed; // RFC 9113 §4.3.1
        }

        while (!cur.done()) {
            const first = cur.bytes[cur.pos];

            if (first & 0x80 == 0x80) {
                // 1xxxxxxx — Indexed Header Field (§6.1): the whole field comes from the table.
                // "The index value of 0 is not used. It MUST be treated as a decoding error".
                const index = try cur.integer(7);
                if (index == 0) return error.Malformed;
                try out.append(arena, try self.fieldAt(index, arena));
            } else if (first & 0xc0 == 0x40) {
                // 01xxxxxx — Literal Header Field with Incremental Indexing (§6.2.1): emit, then insert
                // into the dynamic table. 6-bit name index; 0 means a literal name follows.
                const field = try self.literal(&cur, 6, arena, false);
                try out.append(arena, field);
                // `field` holds arena copies (or static constants), so evicting the entry whose name it
                // referenced cannot pull the rug out from under us (§4.4, last paragraph).
                try self.add(field.name, field.value);
            } else if (first & 0xe0 == 0x20) {
                // 001xxxxx — Dynamic Table Size Update (§6.3). Not a header field: nothing is emitted.
                if (!at_block_start) return error.Malformed; // §4.2: only at the beginning of a block
                const new_capacity = try cur.integer(5);
                // "The new maximum size MUST be lower than or equal to the limit determined by the
                // protocol using HPACK. A value that exceeds this limit MUST be treated as a decoding error."
                if (new_capacity > self.max_table_size) return error.Malformed;
                self.capacity = new_capacity;
                self.evictUntilFits(0); // §4.3
                self.size_update_required = false;
                continue; // leaves `at_block_start` set: §4.2 allows two updates in a row
            } else if (first & 0xf0 == 0x10) {
                // 0001xxxx — Literal Header Field Never Indexed (§6.2.3): like 6.2.2, plus a flag that
                // intermediaries must keep it literal. 4-bit name index.
                try out.append(arena, try self.literal(&cur, 4, arena, true));
            } else {
                // 0000xxxx — Literal Header Field without Indexing (§6.2.2): emit only. 4-bit name index.
                try out.append(arena, try self.literal(&cur, 4, arena, false));
            }
            at_block_start = false;
        }
    }

    /// Current dynamic table size in octets (RFC 7541 4.1).
    pub fn dynamicTableSize(self: *const Decoder) u32 {
        return self.size;
    }

    /// Dynamic table entries, newest first (index 62 = entries[0]).
    pub fn dynamicTableEntries(self: *const Decoder) []const Header {
        return self.entries.items;
    }

    /// Shared tail of §6.2.1/6.2.2/6.2.3: name (index or literal) then value literal.
    fn literal(self: *const Decoder, cur: *Cursor, prefix_bits: u4, arena: std.mem.Allocator, sensitive: bool) DecodeError!Header {
        const name_index = try cur.integer(prefix_bits);
        // Figure 6 vs. Figure 7 of §6.2.1: index 0 = "New Name", the name is a string literal.
        const name = if (name_index == 0) try cur.string(arena) else (try self.fieldAt(name_index, arena)).name;
        const value = try cur.string(arena);
        return .{ .name = name, .value = value, .sensitive = sensitive };
    }

    /// Resolves an index in the combined address space (§2.3.3). Static hits borrow static strings;
    /// dynamic hits are copied into `arena`, because the entry may be evicted later in the same block.
    fn fieldAt(self: *const Decoder, index: u32, arena: std.mem.Allocator) DecodeError!Header {
        if (index == 0) return error.Malformed;
        // "Indices between 1 and the length of the static table (inclusive) refer to elements in the
        // static table" — static_table.entries is 0-based.
        if (index <= static_table.entries.len) {
            const e = static_table.entries[index - 1];
            return .{ .name = e.name, .value = e.value };
        }
        // "The length of the static table is subtracted to find the index into the dynamic table."
        const dyn = index - static_table.entries.len - 1;
        // "Indices strictly greater than the sum of the lengths of both tables MUST be treated as a
        // decoding error."
        if (dyn >= self.entries.items.len) return error.Malformed;
        const e = self.entries.items[dyn];
        return .{ .name = try arena.dupe(u8, e.name), .value = try arena.dupe(u8, e.value) };
    }

    /// §4.4 Entry Eviction When Adding New Entries.
    fn add(self: *Decoder, name: []const u8, value: []const u8) std.mem.Allocator.Error!void {
        const new_size = entrySize(name.len, value.len);
        if (new_size > self.capacity) {
            // "It is not an error to attempt to add an entry that is larger than the maximum size; an
            // attempt to add an entry larger than the maximum size causes the table to be emptied of all
            // existing entries and results in an empty table."
            self.evictAll();
            return;
        }
        // Allocate everything before touching the table, so an OOM leaves the table as it was.
        const owned_name = try self.gpa.dupe(u8, name);
        errdefer self.gpa.free(owned_name);
        const owned_value = try self.gpa.dupe(u8, value);
        errdefer self.gpa.free(owned_value);
        try self.entries.ensureUnusedCapacity(self.gpa, 1);

        // "Before a new entry is added to the dynamic table, entries are evicted from the end of the
        // dynamic table until the size of the dynamic table is less than or equal to (maximum size - new
        // entry size) or until the table is empty."
        self.evictUntilFits(new_size);
        // New entries go to the front: index 62 is always the newest (§2.3.3 Figure 1).
        try self.entries.insert(self.gpa, 0, .{ .name = owned_name, .value = owned_value });
        // new_size <= capacity (a u32), and after eviction size + new_size <= capacity.
        self.size += @intCast(new_size);
    }

    /// Evicts oldest entries until `size + incoming <= capacity` (§4.3 with incoming = 0, §4.4 otherwise).
    fn evictUntilFits(self: *Decoder, incoming: u64) void {
        while (@as(u64, self.size) + incoming > self.capacity) {
            const oldest = self.entries.pop() orelse break;
            self.size -= @intCast(entrySize(oldest.name.len, oldest.value.len));
            self.freeEntry(oldest);
        }
    }

    fn evictAll(self: *Decoder) void {
        for (self.entries.items) |e| self.freeEntry(e);
        self.entries.clearRetainingCapacity();
        self.size = 0;
    }

    fn freeEntry(self: *Decoder, e: Header) void {
        self.gpa.free(e.name);
        self.gpa.free(e.value);
    }
};

/// Read position inside one header block. Every read checks bounds against `bytes` first.
const Cursor = struct {
    bytes: []const u8,
    pos: usize = 0,

    fn done(self: *const Cursor) bool {
        return self.pos >= self.bytes.len;
    }

    fn integer(self: *Cursor, prefix_bits: u4) DecodeError!u32 {
        const r = try decodeInteger(self.bytes[self.pos..], prefix_bits);
        self.pos += r.consumed;
        return r.value;
    }

    /// §5.2 String Literal Representation: H(1) + length as a 7-bit-prefix integer, then the octets.
    /// The result is always a fresh copy in `arena`.
    fn string(self: *Cursor, arena: std.mem.Allocator) DecodeError![]const u8 {
        if (self.done()) return error.Truncated;
        const huffman = self.bytes[self.pos] & 0x80 == 0x80;
        const len = try self.integer(7);
        const rest = self.bytes[self.pos..];
        if (len > rest.len) return error.Truncated;
        const data = rest[0..len];
        self.pos += len;
        if (huffman) return huffmanDecodeAlloc(arena, data);
        return arena.dupe(u8, data);
    }
};

/// §5.1 limits: "Integer encodings that exceed implementation limits -- in value or octet length -- MUST
/// be treated as decoding errors." A u32 needs at most 5 continuation octets (5 * 7 = 35 >= 32 bits).
const max_continuation_octets = 5;

/// Decodes an integer with an N-bit prefix (RFC 7541 5.1). Returns the value and bytes consumed.
/// The bits above the prefix in the first octet belong to the caller (representation pattern, H flag)
/// and are masked off here.
pub fn decodeInteger(bytes: []const u8, prefix_bits: u4) DecodeError!struct { value: u32, consumed: usize } {
    // "The prefix size, N, is always between 1 and 8 bits." Anything else is a caller bug; report it as
    // Malformed instead of asserting, to keep the parse path panic-free.
    if (prefix_bits < 1 or prefix_bits > 8) return error.Malformed;
    if (bytes.len == 0) return error.Truncated;

    // 2^N - 1: a prefix with all N bits set means "the value continues in the following octets".
    const max_prefix: u8 = @truncate((@as(u16, 1) << prefix_bits) - 1);
    const prefix = bytes[0] & max_prefix;
    // "If the integer value is small enough, i.e., strictly less than 2^N-1, it is encoded within the
    // N-bit prefix."
    if (prefix < max_prefix) return .{ .value = prefix, .consumed = 1 };

    // Otherwise the value minus (2^N - 1) follows, 7 bits per octet, least significant group first; the
    // top bit of each octet is the continuation flag (pseudocode in §5.1: I += (B & 127) * 2^M).
    var value: u64 = max_prefix;
    var shift: u6 = 0;
    var i: usize = 1;
    while (true) : (i += 1) {
        if (i > max_continuation_octets) return error.Malformed; // octet-length limit
        if (i >= bytes.len) return error.Truncated;
        const b = bytes[i];
        value += @as(u64, b & 0x7f) << shift;
        if (value > std.math.maxInt(u32)) return error.Malformed; // value limit
        if (b & 0x80 == 0) return .{ .value = @intCast(value), .consumed = i + 1 };
        shift += 7;
    }
}

// ---------------------------------------------------------------------------------------------------
// Huffman decoding (§5.2, Appendix B).
//
// The code is canonical and complete: with EOS included, the Kraft sum of the 257 codes is exactly 1
// (fixtures/hpack/README.md check e). So the codes are the leaves of a *full* binary tree: 257 leaves,
// 256 internal nodes, every internal node has two children. We build that tree at compile time and walk
// it one bit at a time — the slow-but-obvious decoder.
// ---------------------------------------------------------------------------------------------------

/// One internal node. `child[bit]` is either the index of another internal node or `huffman_leaf | sym`.
const HuffmanNode = struct { child: [2]u16 };
const huffman_leaf: u16 = 0x8000;
const huffman_node_count = huffman_table.table.len - 1;

/// Container-level initialisers are evaluated at compile time: no runtime allocation, the tree lands in
/// read-only data. Any inconsistency in huffman_table.zig becomes a compile error, which is what lets
/// the runtime walk below trust every child link without a runtime check.
const huffman_tree: [huffman_node_count]HuffmanNode = blk: {
    @setEvalBranchQuota(100_000);
    const unset: u16 = 0xffff;
    var nodes: [huffman_node_count]HuffmanNode = undefined;
    nodes[0] = .{ .child = .{ unset, unset } }; // root
    var used: usize = 1;

    for (huffman_table.table, 0..) |code, sym| {
        if (code.len < 1 or code.len > 30) @compileError("huffman_table: code length outside 1..30");
        var node: usize = 0;
        // Walk the code MSB first; all bits but the last select internal nodes.
        var depth: usize = code.len;
        while (depth > 1) : (depth -= 1) {
            const bit = (code.code >> @as(u5, @intCast(depth - 1))) & 1;
            const next = nodes[node].child[bit];
            if (next == unset) {
                if (used == huffman_node_count) @compileError("huffman_table: more than 256 internal nodes");
                nodes[used] = .{ .child = .{ unset, unset } };
                nodes[node].child[bit] = @intCast(used);
                node = used;
                used += 1;
            } else if (next & huffman_leaf != 0) {
                @compileError("huffman_table: a code is a prefix of another code");
            } else {
                node = next;
            }
        }
        const last = code.code & 1;
        if (nodes[node].child[last] != unset) @compileError("huffman_table: duplicate code");
        nodes[node].child[last] = huffman_leaf | @as(u16, @intCast(sym));
    }

    // Completeness: exactly 256 internal nodes and no dangling child means every bit pattern leads
    // somewhere — a leaf or a deeper node — so decoding can never fall off the tree.
    if (used != huffman_node_count) @compileError("huffman_table: tree is not full");
    for (nodes) |n| {
        for (n.child) |c| {
            if (c == unset) @compileError("huffman_table: tree has a missing branch");
        }
    }
    break :blk nodes;
};

/// Huffman-decodes `bytes` (Appendix B). Padding longer than 7 bits or an EOS symbol is error.Malformed.
pub fn huffmanDecodeAlloc(gpa: std.mem.Allocator, bytes: []const u8) DecodeError![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    // Shortest code is 5 bits, so at most floor(8n / 5) symbols fit in n octets.
    try out.ensureTotalCapacityPrecise(gpa, bytes.len * 8 / 5);

    var node: u16 = 0; // current internal node; 0 = root = "between symbols"
    var pending_bits: u8 = 0; // bits read since the last complete symbol (<= 29: longest code is 30)
    var pending_all_ones = true; // are all of those bits 1? (i.e. a prefix of EOS)

    for (bytes) |byte| {
        var mask: u8 = 0x80;
        while (mask != 0) : (mask >>= 1) {
            const bit: u1 = @intFromBool(byte & mask != 0);
            pending_bits += 1;
            if (bit == 0) pending_all_ones = false;

            const next = huffman_tree[node].child[bit];
            if (next & huffman_leaf == 0) {
                node = next;
                continue;
            }
            const sym = next & ~huffman_leaf;
            // "A Huffman-encoded string literal containing the EOS symbol MUST be treated as a decoding
            // error."
            if (sym == huffman_table.eos) return error.Malformed;
            try out.append(gpa, @truncate(sym));
            node = 0;
            pending_bits = 0;
            pending_all_ones = true;
        }
    }

    // Leftover bits are padding (§5.2): "an incomplete code at the end of the encoded data is to be
    // considered as padding and discarded. A padding strictly longer than 7 bits MUST be treated as a
    // decoding error. A padding not corresponding to the most significant bits of the code for the EOS
    // symbol MUST be treated as a decoding error." EOS is 30 one-bits, so "MSBs of EOS" = all ones.
    if (pending_bits > 7) return error.Malformed;
    if (!pending_all_ones) return error.Malformed;
    return out.toOwnedSlice(gpa);
}

// ---------------------------------------------------------------------------------------------------
// Tests. Expected values come from RFC 7541 via fixtures/hpack (Appendix C) and spec/test-vectors.json
// (C.1); none are produced by this decoder.
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const fixtures = @import("fixtures");
const spec = @import("spec");
const hex = @import("../hex.zig");

fn jsonField(obj: std.json.ObjectMap, name: []const u8) !std.json.Value {
    return obj.get(name) orelse error.TestUnexpectedResult;
}

fn jsonString(v: std.json.Value) ![]const u8 {
    return switch (v) {
        .string => |s| s,
        else => error.TestUnexpectedResult,
    };
}

fn jsonInt(v: std.json.Value) !i64 {
    return switch (v) {
        .integer => |i| i,
        else => error.TestUnexpectedResult,
    };
}

test "decodeInteger: RFC 7541 C.1 examples (spec/test-vectors.json hpack_integer)" {
    const parsed = try std.json.parseFromSlice(std.json.Value, testing.allocator, spec.test_vectors_json, .{});
    defer parsed.deinit();
    const cases = (try jsonField((try jsonField(parsed.value.object, "hpack_integer")).object, "cases")).array;
    try testing.expectEqual(@as(usize, 3), cases.items.len);
    for (cases.items) |c| {
        const prefix_bits: u4 = @intCast(try jsonInt(try jsonField(c.object, "prefix_bits")));
        const bytes = try hex.decodeAlloc(testing.allocator, try jsonString(try jsonField(c.object, "bytes_hex")));
        defer testing.allocator.free(bytes);
        const r = try decodeInteger(bytes, prefix_bits);
        try testing.expectEqual(try jsonInt(try jsonField(c.object, "expected")), r.value);
        try testing.expectEqual(bytes.len, r.consumed);
    }
}

test "decodeInteger: C.1 by hand, flag bits above the prefix are ignored" {
    // C.1.1: 10 with a 5-bit prefix, in an octet whose top 3 bits are already used ("? ? ?" in Fig. 2).
    const a = try decodeInteger(&.{0xea}, 5); // 111 01010
    try testing.expectEqual(@as(u32, 10), a.value);
    // C.1.2: 1337 with a 5-bit prefix = 31 + 26 + 10 * 128.
    const b = try decodeInteger(&.{ 0x1f, 0x9a, 0x0a, 0xff }, 5); // trailing byte is not consumed
    try testing.expectEqual(@as(u32, 1337), b.value);
    try testing.expectEqual(@as(usize, 3), b.consumed);
    // C.1.3: 42 at an octet boundary (8-bit prefix).
    try testing.expectEqual(@as(u32, 42), (try decodeInteger(&.{0x2a}, 8)).value);
}

test "decodeInteger: limits and truncation" {
    // Largest u32: 31 + 0xffffffe0, groups e0&7f=0x60, 7f, 7f, 7f, 0f.
    const max = try decodeInteger(&.{ 0x1f, 0xe0, 0xff, 0xff, 0xff, 0x0f }, 5);
    try testing.expectEqual(@as(u32, std.math.maxInt(u32)), max.value);
    try testing.expectEqual(@as(usize, 6), max.consumed);
    // One more than u32 max.
    try testing.expectError(error.Malformed, decodeInteger(&.{ 0x1f, 0xe1, 0xff, 0xff, 0xff, 0x0f }, 5));
    // Six continuation octets exceed the octet-length limit even if the value would be small.
    try testing.expectError(error.Malformed, decodeInteger(&.{ 0x1f, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00 }, 5));
    try testing.expectError(error.Truncated, decodeInteger(&.{}, 5));
    try testing.expectError(error.Truncated, decodeInteger(&.{0x1f}, 5));
    try testing.expectError(error.Truncated, decodeInteger(&.{ 0x1f, 0x9a }, 5));
    try testing.expectError(error.Malformed, decodeInteger(&.{0x00}, 0));
    try testing.expectError(error.Malformed, decodeInteger(&.{0x00}, 9));
}

test "huffmanDecodeAlloc: literals from Appendix C.4 / C.6 fixtures" {
    const gpa = testing.allocator;
    // C.4.1 ":authority: www.example.com" — the RFC prints the Huffman bytes f1e3c2e5f23a6ba0ab90f4ff.
    {
        const bytes = try hex.decodeAlloc(gpa, "f1e3c2e5f23a6ba0ab90f4ff");
        defer gpa.free(bytes);
        const s = try huffmanDecodeAlloc(gpa, bytes);
        defer gpa.free(s);
        try testing.expectEqualStrings("www.example.com", s);
    }
    // Same literal cut straight out of fixtures/hpack/c4_1.hex: 82 86 84 41 | 8c | 12 bytes. The expected
    // text is the JSON header value, i.e. the RFC's decoded header list.
    {
        const block = try hex.decodeAlloc(gpa, fixtures.hpack.cases[7].hex);
        defer gpa.free(block);
        try testing.expectEqualStrings("C.4.1", fixtures.hpack.cases[7].section);
        try testing.expectEqual(@as(u8, 0x8c), block[4]); // H=1, length 12
        const s = try huffmanDecodeAlloc(gpa, block[5..17]);
        defer gpa.free(s);
        const parsed = try std.json.parseFromSlice(std.json.Value, gpa, fixtures.hpack.cases[7].json, .{});
        defer parsed.deinit();
        const want = (try jsonField(parsed.value.object, "headers")).array.items[3].array.items[1];
        try testing.expectEqualStrings(try jsonString(want), s);
    }
    // Empty input is the empty string.
    const empty = try huffmanDecodeAlloc(gpa, "");
    defer gpa.free(empty);
    try testing.expectEqual(@as(usize, 0), empty.len);
}

test "huffmanDecodeAlloc: padding and EOS errors (§5.2)" {
    const gpa = testing.allocator;
    // '0' is the 5-bit code 00000 (Appendix B). 00000|111 = 0x07: '0' + 3 bits of EOS-prefix padding.
    const ok = try huffmanDecodeAlloc(gpa, &.{0x07});
    defer gpa.free(ok);
    try testing.expectEqualStrings("0", ok);
    // 00000|110: padding contains a 0 -> not a prefix of EOS.
    try testing.expectError(error.Malformed, huffmanDecodeAlloc(gpa, &.{0x06}));
    // 00000|000: likewise.
    try testing.expectError(error.Malformed, huffmanDecodeAlloc(gpa, &.{0x00}));
    // Eight 1-bits: padding strictly longer than 7 bits.
    try testing.expectError(error.Malformed, huffmanDecodeAlloc(gpa, &.{0xff}));
    // "www.example.com" followed by one extra 0xff: the old padding plus 8 more ones is > 7 bits.
    try testing.expectError(error.Malformed, huffmanDecodeAlloc(gpa, &.{ 0xf1, 0xe3, 0xc2, 0xe5, 0xf2, 0x3a, 0x6b, 0xa0, 0xab, 0x90, 0xf4, 0xff, 0xff }));
    // 32 one-bits: the first 30 are the EOS code itself.
    try testing.expectError(error.Malformed, huffmanDecodeAlloc(gpa, &.{ 0xff, 0xff, 0xff, 0xff }));
}

test "huffman tree: every Appendix B code decodes to its own symbol" {
    // Encode each symbol alone (MSB-first, padded with ones) and decode it back. The code table is the
    // oracle; this checks the comptime tree construction, not the table.
    const gpa = testing.allocator;
    for (huffman_table.table[0..256], 0..) |code, sym| {
        var buf: [5]u8 = undefined;
        const total_bits: usize = (code.len + 7) / 8 * 8;
        const pad: u6 = @intCast(total_bits - code.len);
        const word: u64 = (@as(u64, code.code) << pad) | ((@as(u64, 1) << pad) - 1);
        const nbytes = total_bits / 8;
        for (0..nbytes) |k| buf[k] = @truncate(word >> @intCast((nbytes - 1 - k) * 8));
        const s = try huffmanDecodeAlloc(gpa, buf[0..nbytes]);
        defer gpa.free(s);
        try testing.expectEqual(@as(usize, 1), s.len);
        try testing.expectEqual(@as(u8, @intCast(sym)), s[0]);
    }
}

test "decodeBlock: RFC 7541 Appendix C.2-C.6 (fixtures/hpack), dynamic table after every block" {
    const gpa = testing.allocator;
    var decoder: ?Decoder = null;
    defer if (decoder) |*d| d.deinit();
    var previous_section: []const u8 = "";

    for (fixtures.hpack.cases) |case| {
        const parsed = try std.json.parseFromSlice(std.json.Value, gpa, case.json, .{});
        defer parsed.deinit();
        const root = parsed.value.object;
        try testing.expectEqualStrings(case.section, try jsonString(try jsonField(root, "section")));

        // `continues_from`: null = fresh connection; otherwise keep the previous block's table.
        switch (try jsonField(root, "continues_from")) {
            .null => {
                if (decoder) |*old| old.deinit();
                // RFC 9113 §6.5.2: 4096 is the initial SETTINGS_HEADER_TABLE_SIZE; C.5/C.6 then set 256.
                var fresh = Decoder.init(gpa, 4096);
                const max: u32 = @intCast(try jsonInt(try jsonField(root, "dynamic_table_max_size")));
                if (max != 4096) fresh.setMaxTableSize(max);
                decoder = fresh;
            },
            .string => |from| try testing.expectEqualStrings(previous_section, from),
            else => return error.TestUnexpectedResult,
        }
        previous_section = case.section;
        const d: *Decoder = if (decoder) |*p| p else return error.TestUnexpectedResult;

        const block = try hex.decodeAlloc(gpa, case.hex);
        defer gpa.free(block);
        var arena_state = std.heap.ArenaAllocator.init(gpa);
        defer arena_state.deinit();
        var out: std.ArrayList(Header) = .empty;
        try d.decodeBlock(block, arena_state.allocator(), &out);

        // Header list: names, values and order.
        const want_headers = (try jsonField(root, "headers")).array.items;
        try testing.expectEqual(want_headers.len, out.items.len);
        for (want_headers, out.items) |w, got| {
            try testing.expectEqualStrings(try jsonString(w.array.items[0]), got.name);
            try testing.expectEqualStrings(try jsonString(w.array.items[1]), got.value);
        }
        // C.2.3 is the one never-indexed example.
        if (std.mem.eql(u8, case.section, "C.2.3")) try testing.expect(out.items[0].sensitive);

        // Dynamic table after the block: total size, then entries from index 62 (newest) on.
        const after = (try jsonField(root, "dynamic_table_after")).object;
        try testing.expectEqual(try jsonInt(try jsonField(after, "size")), d.dynamicTableSize());
        const want_entries = (try jsonField(after, "entries")).array.items;
        const got_entries = d.dynamicTableEntries();
        try testing.expectEqual(want_entries.len, got_entries.len);
        for (want_entries, got_entries, 0..) |w, got, i| {
            try testing.expectEqual(@as(i64, @intCast(62 + i)), try jsonInt(try jsonField(w.object, "index")));
            try testing.expectEqualStrings(try jsonString(try jsonField(w.object, "name")), got.name);
            try testing.expectEqualStrings(try jsonString(try jsonField(w.object, "value")), got.value);
            try testing.expectEqual(try jsonInt(try jsonField(w.object, "size")), @as(i64, @intCast(entrySize(got.name.len, got.value.len))));
        }
    }
}

test "decodeBlock: index errors (§2.3.3, §6.1)" {
    const gpa = testing.allocator;
    var d = Decoder.init(gpa, 4096);
    defer d.deinit();
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var out: std.ArrayList(Header) = .empty;

    try testing.expectError(error.Malformed, d.decodeBlock(&.{0x80}, arena, &out)); // indexed, index 0
    try testing.expectError(error.Malformed, d.decodeBlock(&.{0xbe}, arena, &out)); // index 62, table empty
    try testing.expectError(error.Malformed, d.decodeBlock(&.{ 0x7f, 0x00 }, arena, &out)); // name index 63
    // 61 is the last static entry and is fine.
    out.clearRetainingCapacity();
    try d.decodeBlock(&.{0xbd}, arena, &out);
    try testing.expectEqualStrings("www-authenticate", out.items[0].name);
    // String length runs past the block.
    try testing.expectError(error.Truncated, d.decodeBlock(&.{ 0x40, 0x05, 'a', 'b' }, arena, &out));
    // Literal name present, value missing entirely.
    try testing.expectError(error.Truncated, d.decodeBlock(&.{ 0x00, 0x01, 'a' }, arena, &out));
}

test "decodeBlock: dynamic table size update (§4.2, §4.3, §6.3) and oversize entries (§4.4)" {
    const gpa = testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var out: std.ArrayList(Header) = .empty;

    var d = Decoder.init(gpa, 4096);
    defer d.deinit();
    // C.3.1's block leaves ":authority: www.example.com" (57 octets) in the table.
    const c3_1 = try hex.decodeAlloc(gpa, fixtures.hpack.cases[4].hex);
    defer gpa.free(c3_1);
    try d.decodeBlock(c3_1, arena, &out);
    try testing.expectEqual(@as(u32, 57), d.dynamicTableSize());

    // Size update above the protocol limit: 001 11111 + (4097 - 31 = 4066 = 0x62 | 0x1f<<7).
    try testing.expectError(error.Malformed, d.decodeBlock(&.{ 0x3f, 0xe2, 0x1f }, arena, &out));
    // Size update after a field representation.
    try testing.expectError(error.Malformed, d.decodeBlock(&.{ 0x82, 0x20 }, arena, &out));
    // Two size updates at the start are fine (§4.2); 0 empties the table, 4096 restores capacity.
    try d.decodeBlock(&.{ 0x20, 0x3f, 0xe1, 0x1f }, arena, &out);
    try testing.expectEqual(@as(u32, 0), d.dynamicTableSize());
    try testing.expectEqual(@as(u32, 4096), d.capacity);

    // Shrink capacity to 40 (enough for one 32 + 1 + 1 entry), then add an entry that does not fit:
    // the table is emptied, no error (§4.4).
    try d.decodeBlock(&.{ 0x3f, 0x09, 0x40, 0x01, 'a', 0x01, 'b' }, arena, &out); // 31 + 9 = 40
    try testing.expectEqual(@as(u32, 34), d.dynamicTableSize());
    try d.decodeBlock(&.{ 0x40, 0x01, 'c', 0x08, '1', '2', '3', '4', '5', '6', '7', '8' }, arena, &out);
    try testing.expectEqual(@as(u32, 0), d.dynamicTableSize());
    try testing.expectEqual(@as(usize, 0), d.dynamicTableEntries().len);
}

test "setMaxTableSize: evicts, and a reduction below the current size demands a size update (RFC 9113 §4.3.1)" {
    const gpa = testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var out: std.ArrayList(Header) = .empty;

    var d = Decoder.init(gpa, 4096);
    defer d.deinit();
    const c3_1 = try hex.decodeAlloc(gpa, fixtures.hpack.cases[4].hex);
    defer gpa.free(c3_1);
    try d.decodeBlock(c3_1, arena, &out); // one 57-octet entry

    d.setMaxTableSize(50);
    try testing.expectEqual(@as(u32, 0), d.dynamicTableSize()); // evicted immediately (§4.3)
    try testing.expectEqual(@as(u32, 50), d.capacity);
    // Next block does not start with a size update -> COMPRESSION_ERROR.
    try testing.expectError(error.Malformed, d.decodeBlock(&.{0x82}, arena, &out));
    // A conformant update (<= 50) satisfies the requirement.
    out.clearRetainingCapacity();
    try d.decodeBlock(&.{ 0x3f, 0x00, 0x82 }, arena, &out); // update to 31, then :method GET
    try testing.expectEqual(@as(u32, 31), d.capacity);
    try testing.expectEqualStrings(":method", out.items[0].name);
    // Raising the limit does not grow the table until the encoder says so.
    d.setMaxTableSize(8192);
    try testing.expectEqual(@as(u32, 31), d.capacity);
    try testing.expect(!d.size_update_required);
}

test "decodeBlock: an entry referencing a name that its own insertion evicts (§4.4 last paragraph)" {
    const gpa = testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var out: std.ArrayList(Header) = .empty;

    // Capacity 70: "x-name: v" (32 + 6 + 1 = 39) fits alone but not twice.
    var d = Decoder.init(gpa, 70);
    defer d.deinit();
    try d.decodeBlock(&.{ 0x40, 0x06, 'x', '-', 'n', 'a', 'm', 'e', 0x01, 'v' }, arena, &out);
    // 01 111110 = incremental indexing, name index 62 (the entry just added), value "w".
    try d.decodeBlock(&.{ 0x7e, 0x01, 'w' }, arena, &out);
    try testing.expectEqual(@as(usize, 1), d.dynamicTableEntries().len);
    try testing.expectEqualStrings("x-name", d.dynamicTableEntries()[0].name);
    try testing.expectEqualStrings("w", d.dynamicTableEntries()[0].value);
    try testing.expectEqualStrings("x-name", out.items[1].name);
}
