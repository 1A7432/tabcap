//! `wireprint diff [--json] [--raw] a.json b.json`: diff of two JSON documents grouped by top-level key
//! (the layers: tls / http2 / http / tcp / ...). Works on any JSON (two corpus profiles, a profile against
//! an impersonation library's output), and knows one shape specially: two per-connection reports
//! (`report` output, anything with `tls.client_hello`) are normalised first unless `--raw` is given.
//!
//! Report normalisation (why: two connections of the same Chrome must not differ):
//!   - GREASE values (RFC 8701, ?a?a) are drawn fresh per connection: removed from every list
//!     (cipher_suites, extensions, supported_versions, supported_groups, key_share_groups,
//!     signature_algorithms, key_shares); `extension_grease_count` keeps how many GREASE extensions came.
//!   - Chrome permutes its extensions per connection: `extensions` becomes the sorted set of types and
//!     the order-bearing values (extensions_order, ja3, ja4_o, ja4_ro) are left out (listed under
//!     `ignored`; `check` judges order against a profile that knows whether it is random).
//!   - pre_shared_key (0029) only appears on resumption: it is dropped from the lists and, when the two
//!     sides differ, reported once as the label `psk` instead of as field differences (JA4 / JA4_r and
//!     session_reused then depend on it and are ignored too).
//!   - per-connection values (random, session_id, ECH-padded lengths, the connection section, the echo's
//!     own annotations) and the request target / authority values (they name the echo) are ignored.
//! Every ignored path is listed in the output, so nothing disappears silently.
//!
//! Output: text (one line per difference, grouped by section, then `summary: ...`) or JSON:
//!   {"normalized":bool, "labels":[{label,a,b}], "ignored":[{path,reason}],
//!    "differences":[{path, kind: changed|reordered|added|removed, a, b}], "summary":{...}}
//! Arrays of scalars are compared as sets AND as sequences: "same set, different order" is `reordered`.
const std = @import("std");
const Value = std.json.Value;

pub const Options = struct {
    /// Print unchanged leaves too (text).
    verbose: bool = false,
    /// Maximum characters printed for a scalar value (text).
    max_value_len: usize = 72,
};

pub const CompareOptions = struct {
    /// Normalise two reports before comparing (see the file comment).
    normalize: bool = true,
};

pub const Stats = struct { changed: usize = 0, added: usize = 0, removed: usize = 0, reordered: usize = 0, unchanged: usize = 0 };

pub const Kind = enum { changed, reordered, added, removed };

pub const Difference = struct { path: []const u8, kind: Kind, a: ?Value, b: ?Value };
pub const Label = struct { label: []const u8, a: Value, b: Value };
pub const Ignored = struct { path: []const u8, reason: []const u8 };

pub const Result = struct {
    normalized: bool,
    labels: []const Label,
    ignored: []const Ignored,
    differences: []const Difference,
    /// Top-level keys in document order (text output prints one header per section).
    sections: []const []const u8,
    stats: Stats,
};

pub const Error = std.mem.Allocator.Error;

/// Compares `a` and `b`. Everything is allocated in `arena` (the inputs are not modified).
pub fn compare(arena: std.mem.Allocator, a: Value, b: Value, opts: CompareOptions) Error!Result {
    var labels: std.ArrayList(Label) = .empty;
    var ignored: std.ArrayList(Ignored) = .empty;
    var x = a;
    var y = b;
    const normalized = opts.normalize and isReport(a) and isReport(b);
    if (normalized) {
        const pa = getBool(a, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false;
        const pb = getBool(b, &.{ "tls", "client_hello", "has_pre_shared_key" }) orelse false;
        const psk_differs = pa != pb;
        if (psk_differs) try labels.append(arena, .{ .label = "psk", .a = .{ .bool = pa }, .b = .{ .bool = pb } });
        x = try normalizeReport(arena, a, psk_differs);
        y = try normalizeReport(arena, b, psk_differs);
        for (ignored_always) |ig| try ignored.append(arena, ig);
        if (psk_differs) for (ignored_psk) |ig| try ignored.append(arena, ig);
    }

    var w: Walker = .{ .arena = arena };
    var sections: std.ArrayList([]const u8) = .empty;
    if (x == .object and y == .object) {
        var keys: std.ArrayList([]const u8) = .empty;
        try collectKeys(arena, &keys, x.object, y.object);
        for (keys.items) |k| {
            try sections.append(arena, k);
            const av = x.object.get(k);
            const bv = y.object.get(k);
            if (av != null and bv != null) {
                try w.node(k, av.?, bv.?);
            } else if (bv != null) {
                try w.add(.added, k, null, bv.?);
            } else {
                try w.add(.removed, k, av.?, null);
            }
        }
    } else try w.node("", x, y);

    return .{
        .normalized = normalized,
        .labels = labels.items,
        .ignored = ignored.items,
        .differences = w.list.items,
        .sections = sections.items,
        .stats = w.stats,
    };
}

const ignored_always = [_]Ignored{
    .{ .path = "connection", .reason = "per-connection metadata" },
    .{ .path = "wireprint", .reason = "producer version" },
    .{ .path = "echo", .reason = "annotations of the echo that captured the connection" },
    .{ .path = "role", .reason = "request role the echo derived from the path" },
    .{ .path = "tls.client_hello.random", .reason = "per-connection value" },
    .{ .path = "tls.client_hello.session_id", .reason = "per-connection value" },
    .{ .path = "tls.client_hello.message_length", .reason = "varies with the ECH GREASE padding" },
    .{ .path = "tls.client_hello.extensions[].length", .reason = "varies with the ECH GREASE padding" },
    .{ .path = "tls.client_hello.extensions_order", .reason = "order is compared by check against a profile; Chrome permutes it per connection" },
    .{ .path = "tls.client_hello.extension_grease_positions", .reason = "positions in the permuted order; extension_grease_count is compared" },
    .{ .path = "tls.ja3", .reason = "covers the extension order" },
    .{ .path = "tls.ja4.ja4_o", .reason = "covers the extension order" },
    .{ .path = "tls.ja4.ja4_ro", .reason = "covers the extension order" },
    .{ .path = "http2.frames[].length", .reason = "HEADERS length follows the request target" },
    .{ .path = "http.headers.:path", .reason = "names the echo's request target" },
    .{ .path = "http.headers.:authority", .reason = "names the echo's host and port" },
    .{ .path = "http.headers.host", .reason = "names the echo's host and port" },
};

const ignored_psk = [_]Ignored{
    .{ .path = "tls.ja4.ja4", .reason = "psk label: JA4 counts pre_shared_key" },
    .{ .path = "tls.ja4.ja4_r", .reason = "psk label: JA4_r lists pre_shared_key" },
    .{ .path = "tls.handshake.session_reused", .reason = "psk label" },
};

fn isReport(v: Value) bool {
    const ch = get(v, &.{ "tls", "client_hello" }) orelse return false;
    return ch == .object;
}

fn get(v: Value, path: []const []const u8) ?Value {
    var cur = v;
    for (path) |k| {
        if (cur != .object) return null;
        cur = cur.object.get(k) orelse return null;
    }
    return cur;
}

fn getBool(v: Value, path: []const []const u8) ?bool {
    const x = get(v, path) orelse return null;
    return if (x == .bool) x.bool else null;
}

pub fn isGreaseHex(s: []const u8) bool {
    return s.len == 4 and s[0] == s[2] and s[1] == s[3] and s[1] == 'a';
}

fn isPsk(s: []const u8) bool {
    return std.mem.eql(u8, s, "0029");
}

/// Shallow copy of an object (keys borrowed) so entries can be replaced or removed.
fn copyObject(arena: std.mem.Allocator, o: std.json.ObjectMap) Error!std.json.ObjectMap {
    var out: std.json.ObjectMap = .empty;
    var it = o.iterator();
    while (it.next()) |e| try out.put(arena, e.key_ptr.*, e.value_ptr.*);
    return out;
}

/// A string list without GREASE (and without 0029 when `drop_psk`); non-arrays pass through.
fn stripList(arena: std.mem.Allocator, v: Value, drop_psk: bool) Error!Value {
    if (v != .array) return v;
    var out: std.json.Array = .init(arena);
    for (v.array.items) |item| {
        if (item == .string and (isGreaseHex(item.string) or (drop_psk and isPsk(item.string)))) continue;
        try out.append(item);
    }
    return .{ .array = out };
}

fn strLess(_: void, a: Value, b: Value) bool {
    const as = if (a == .string) a.string else "";
    const bs = if (b == .string) b.string else "";
    return std.mem.lessThan(u8, as, bs);
}

fn normalizeReport(arena: std.mem.Allocator, v: Value, psk_differs: bool) Error!Value {
    var top = try copyObject(arena, v.object);
    _ = top.orderedRemove("connection");
    _ = top.orderedRemove("wireprint");
    _ = top.orderedRemove("echo");
    _ = top.orderedRemove("role");

    if (top.get("tls")) |tls_v| if (tls_v == .object) {
        var tls = try copyObject(arena, tls_v.object);
        _ = tls.orderedRemove("ja3");
        if (tls.get("ja4")) |j| if (j == .object) {
            var ja4 = try copyObject(arena, j.object);
            _ = ja4.orderedRemove("ja4_o");
            _ = ja4.orderedRemove("ja4_ro");
            if (psk_differs) {
                _ = ja4.orderedRemove("ja4");
                _ = ja4.orderedRemove("ja4_r");
            }
            try tls.put(arena, "ja4", .{ .object = ja4 });
        };
        if (psk_differs) if (tls.get("handshake")) |h| if (h == .object) {
            var hs = try copyObject(arena, h.object);
            _ = hs.orderedRemove("session_reused");
            try tls.put(arena, "handshake", .{ .object = hs });
        };
        if (tls.get("client_hello")) |c| if (c == .object) {
            var ch = try copyObject(arena, c.object);
            _ = ch.orderedRemove("random");
            _ = ch.orderedRemove("session_id");
            _ = ch.orderedRemove("message_length");
            _ = ch.orderedRemove("has_pre_shared_key");
            _ = ch.orderedRemove("extension_grease_positions");
            inline for (.{ "cipher_suites", "supported_versions", "supported_groups", "key_share_groups", "signature_algorithms" }) |k| {
                if (ch.get(k)) |list| try ch.put(arena, k, try stripList(arena, list, false));
            }
            // extensions: sorted set of types, GREASE and PSK removed; GREASE extensions only counted.
            var grease_count: i64 = 0;
            var types: std.json.Array = .init(arena);
            if (ch.get("extensions_order")) |order| if (order == .array) {
                for (order.array.items) |t| {
                    if (t != .string) continue;
                    if (isGreaseHex(t.string)) {
                        grease_count += 1;
                    } else if (!isPsk(t.string)) try types.append(t);
                }
            };
            std.mem.sort(Value, types.items, {}, strLess);
            _ = ch.orderedRemove("extensions_order");
            try ch.put(arena, "extensions", .{ .array = types });
            try ch.put(arena, "extension_count", .{ .integer = @intCast(types.items.len) });
            try ch.put(arena, "extension_grease_count", .{ .integer = grease_count });
            if (ch.get("key_shares")) |ks| if (ks == .array) {
                var out: std.json.Array = .init(arena);
                for (ks.array.items) |e| {
                    const g = get(e, &.{"group"});
                    if (g != null and g.? == .string and isGreaseHex(g.?.string)) continue;
                    try out.append(e);
                }
                try ch.put(arena, "key_shares", .{ .array = out });
            };
            try tls.put(arena, "client_hello", .{ .object = ch });
        };
        try top.put(arena, "tls", .{ .object = tls });
    };

    if (top.get("http2")) |h2v| if (h2v == .object) {
        var h2 = try copyObject(arena, h2v.object);
        if (h2.get("frames")) |frames| if (frames == .array) {
            var out: std.json.Array = .init(arena);
            for (frames.array.items) |f| {
                if (f != .object) {
                    try out.append(f);
                    continue;
                }
                var fo = try copyObject(arena, f.object);
                _ = fo.orderedRemove("length");
                try out.append(.{ .object = fo });
            }
            try h2.put(arena, "frames", .{ .array = out });
        };
        try top.put(arena, "http2", .{ .object = h2 });
    };

    if (top.get("http")) |hv| if (hv == .object) {
        var http = try copyObject(arena, hv.object);
        // headers: [{name, value?}] -> {name: value|null} in wire order (repeated names get "#2", "#3").
        if (http.get("headers")) |hs| if (hs == .array) {
            var map: std.json.ObjectMap = .empty;
            for (hs.array.items) |h| {
                const n = get(h, &.{"name"}) orelse continue;
                if (n != .string) continue;
                var key = n.string;
                var dup: usize = 2;
                while (map.get(key) != null) : (dup += 1) key = try std.fmt.allocPrint(arena, "{s}#{d}", .{ n.string, dup });
                const echo_named = std.mem.eql(u8, n.string, ":path") or std.mem.eql(u8, n.string, ":authority") or std.ascii.eqlIgnoreCase(n.string, "host");
                const val: Value = if (echo_named) .null else get(h, &.{"value"}) orelse .null;
                try map.put(arena, key, val);
            }
            try http.put(arena, "headers", .{ .object = map });
        };
        try top.put(arena, "http", .{ .object = http });
    };
    return .{ .object = top };
}

const Walker = struct {
    arena: std.mem.Allocator,
    list: std.ArrayList(Difference) = .empty,
    stats: Stats = .{},

    fn add(self: *Walker, kind: Kind, path: []const u8, a: ?Value, b: ?Value) Error!void {
        switch (kind) {
            .changed => self.stats.changed += 1,
            .reordered => self.stats.reordered += 1,
            .added => self.stats.added += 1,
            .removed => self.stats.removed += 1,
        }
        try self.list.append(self.arena, .{ .path = path, .kind = kind, .a = a, .b = b });
    }

    fn child(self: *Walker, path: []const u8, key: []const u8) Error![]const u8 {
        if (path.len == 0) return key;
        return std.fmt.allocPrint(self.arena, "{s}.{s}", .{ path, key });
    }

    fn node(self: *Walker, path: []const u8, a: Value, b: Value) Error!void {
        if (a == .object and b == .object) {
            var keys: std.ArrayList([]const u8) = .empty;
            try collectKeys(self.arena, &keys, a.object, b.object);
            for (keys.items) |k| {
                const p = try self.child(path, k);
                const av = a.object.get(k);
                const bv = b.object.get(k);
                if (av != null and bv != null) {
                    try self.node(p, av.?, bv.?);
                } else if (bv != null) {
                    try self.add(.added, p, null, bv.?);
                } else {
                    try self.add(.removed, p, av.?, null);
                }
            }
            return;
        }
        if (a == .array and b == .array and isScalarArray(a.array) and isScalarArray(b.array)) {
            if (equal(a, b)) {
                self.stats.unchanged += 1;
            } else if (sameSet(a.array, b.array)) {
                try self.add(.reordered, path, a, b);
            } else try self.add(.changed, path, a, b);
            return;
        }
        if (a == .array and b == .array) {
            const n = @max(a.array.items.len, b.array.items.len);
            var i: usize = 0;
            while (i < n) : (i += 1) {
                const p = try std.fmt.allocPrint(self.arena, "{s}[{d}]", .{ path, i });
                if (i < a.array.items.len and i < b.array.items.len) {
                    try self.node(p, a.array.items[i], b.array.items[i]);
                } else if (i < b.array.items.len) {
                    try self.add(.added, p, null, b.array.items[i]);
                } else {
                    try self.add(.removed, p, a.array.items[i], null);
                }
            }
            return;
        }
        if (equal(a, b)) {
            self.stats.unchanged += 1;
            return;
        }
        try self.add(.changed, path, a, b);
    }
};

fn collectKeys(gpa: std.mem.Allocator, keys: *std.ArrayList([]const u8), a: std.json.ObjectMap, b: std.json.ObjectMap) Error!void {
    var it = a.iterator();
    while (it.next()) |e| try keys.append(gpa, e.key_ptr.*);
    var itb = b.iterator();
    while (itb.next()) |e| {
        if (a.get(e.key_ptr.*) == null) try keys.append(gpa, e.key_ptr.*);
    }
}

/// Scalars, or tuples of scalars (SETTINGS `[id, value]` pairs, PRIORITY records): compared as one list
/// (equal / same set in another order / changed), not element by element.
fn isScalarArray(arr: std.json.Array) bool {
    for (arr.items) |v| switch (v) {
        .object => return false,
        .array => |inner| for (inner.items) |x| switch (x) {
            .object, .array => return false,
            else => {},
        },
        else => {},
    };
    return true;
}

fn contains(arr: std.json.Array, v: Value) bool {
    for (arr.items) |x| if (equal(x, v)) return true;
    return false;
}

fn sameSet(a: std.json.Array, b: std.json.Array) bool {
    if (a.items.len != b.items.len) return false;
    for (a.items) |x| if (!contains(b, x)) return false;
    for (b.items) |x| if (!contains(a, x)) return false;
    return true;
}

pub fn equal(a: Value, b: Value) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) {
        // 1 vs 1.0 compare equal
        if (a == .integer and b == .float) return @as(f64, @floatFromInt(a.integer)) == b.float;
        if (a == .float and b == .integer) return a.float == @as(f64, @floatFromInt(b.integer));
        return false;
    }
    return switch (a) {
        .null => true,
        .bool => a.bool == b.bool,
        .integer => a.integer == b.integer,
        .float => a.float == b.float,
        .number_string => std.mem.eql(u8, a.number_string, b.number_string),
        .string => std.mem.eql(u8, a.string, b.string),
        .array => blk: {
            if (a.array.items.len != b.array.items.len) break :blk false;
            for (a.array.items, b.array.items) |x, y| if (!equal(x, y)) break :blk false;
            break :blk true;
        },
        .object => blk: {
            if (a.object.count() != b.object.count()) break :blk false;
            var it = a.object.iterator();
            while (it.next()) |e| {
                const other = b.object.get(e.key_ptr.*) orelse break :blk false;
                if (!equal(e.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}

// ---------------------------------------------------------------- output

pub fn writeJson(js: *std.json.Stringify, r: Result) std.Io.Writer.Error!void {
    try js.beginObject();
    try js.objectField("normalized");
    try js.write(r.normalized);
    try js.objectField("labels");
    try js.beginArray();
    for (r.labels) |l| {
        try js.beginObject();
        try js.objectField("label");
        try js.write(l.label);
        try js.objectField("a");
        try js.write(l.a);
        try js.objectField("b");
        try js.write(l.b);
        try js.endObject();
    }
    try js.endArray();
    try js.objectField("ignored");
    try js.beginArray();
    for (r.ignored) |ig| {
        try js.beginObject();
        try js.objectField("path");
        try js.write(ig.path);
        try js.objectField("reason");
        try js.write(ig.reason);
        try js.endObject();
    }
    try js.endArray();
    try js.objectField("differences");
    try js.beginArray();
    for (r.differences) |d| {
        try js.beginObject();
        try js.objectField("path");
        try js.write(d.path);
        try js.objectField("kind");
        try js.write(@tagName(d.kind));
        try js.objectField("a");
        if (d.a) |v| try js.write(v) else try js.write(null);
        try js.objectField("b");
        if (d.b) |v| try js.write(v) else try js.write(null);
        try js.endObject();
    }
    try js.endArray();
    try js.objectField("summary");
    try js.beginObject();
    inline for (.{ "changed", "reordered", "added", "removed", "unchanged" }) |f| {
        try js.objectField(f);
        try js.write(@field(r.stats, f));
    }
    try js.endObject();
    try js.endObject();
}

fn sectionOf(path: []const u8) []const u8 {
    const end = std.mem.indexOfAny(u8, path, ".[") orelse path.len;
    return path[0..end];
}

/// Text: each top-level section, its differences indented (`<path> <a> -> <b>`, `+b`, `-a`, set
/// differences for lists), then labels and the summary line.
pub fn writeText(out: *std.Io.Writer, r: Result, opts: Options) std.Io.Writer.Error!void {
    for (r.sections) |s| {
        try out.print("{s}\n", .{s});
        for (r.differences) |d| {
            if (!std.mem.eql(u8, sectionOf(d.path), s)) continue;
            var pbuf: [512]u8 = undefined;
            const shown = std.fmt.bufPrint(&pbuf, "  {s}", .{if (std.mem.eql(u8, d.path, s)) s else d.path[s.len + @intFromBool(d.path.len > s.len and d.path[s.len] == '.') ..]}) catch d.path;
            switch (d.kind) {
                .added => {
                    try out.print("{s: <28} +", .{shown});
                    if (d.b) |v| try printValue(out, v, opts.max_value_len);
                },
                .removed => {
                    try out.print("{s: <28} -", .{shown});
                    if (d.a) |v| try printValue(out, v, opts.max_value_len);
                },
                .reordered => try out.print("{s: <28} reordered (same {d} values, different order)", .{ shown, if (d.a) |v| (if (v == .array) v.array.items.len else 0) else 0 }),
                .changed => {
                    try out.print("{s: <28} ", .{shown});
                    if (d.a != null and d.b != null and d.a.? == .array and d.b.? == .array) {
                        try printSetDiff(out, d.a.?.array, d.b.?.array, opts.max_value_len);
                    } else {
                        if (d.a) |v| try printValue(out, v, opts.max_value_len) else try out.writeAll("null");
                        try out.writeAll(" -> ");
                        if (d.b) |v| try printValue(out, v, opts.max_value_len) else try out.writeAll("null");
                    }
                },
            }
            try out.writeAll("\n");
        }
    }
    for (r.labels) |l| {
        try out.print("label {s}: ", .{l.label});
        try printValue(out, l.a, opts.max_value_len);
        try out.writeAll(" -> ");
        try printValue(out, l.b, opts.max_value_len);
        try out.writeAll("\n");
    }
    if (r.normalized) try out.print("normalized: GREASE and pre_shared_key removed, {d} per-connection path(s) ignored (--json lists them, --raw keeps them)\n", .{r.ignored.len});
    try out.print("summary: {d} changed, {d} reordered, {d} added, {d} removed, {d} unchanged\n", .{ r.stats.changed, r.stats.reordered, r.stats.added, r.stats.removed, r.stats.unchanged });
}

fn printSetDiff(out: *std.Io.Writer, a: std.json.Array, b: std.json.Array, max_len: usize) std.Io.Writer.Error!void {
    var printed = false;
    for (b.items) |bv| {
        if (!contains(a, bv)) {
            try out.writeAll(if (printed) " +" else "+");
            try printValue(out, bv, max_len);
            printed = true;
        }
    }
    for (a.items) |av| {
        if (!contains(b, av)) {
            try out.writeAll(if (printed) " -" else "-");
            try printValue(out, av, max_len);
            printed = true;
        }
    }
    if (!printed) try out.print("({d} -> {d} values, duplicates differ)", .{ a.items.len, b.items.len });
}

fn printValue(out: *std.Io.Writer, v: Value, max_len: usize) std.Io.Writer.Error!void {
    switch (v) {
        .null => try out.writeAll("null"),
        .bool => |x| try out.print("{}", .{x}),
        .integer => |x| try out.print("{d}", .{x}),
        .float => |x| try out.print("{d}", .{x}),
        .number_string => |s| try out.writeAll(s),
        .string => |s| {
            if (s.len > max_len) {
                try out.print("{s}…", .{s[0..max_len]});
            } else try out.writeAll(s);
        },
        .array => |arr| {
            try out.writeAll("[");
            for (arr.items, 0..) |x, i| {
                if (i > 0) try out.writeAll(",");
                if (i >= 8) {
                    try out.print("…({d})", .{arr.items.len});
                    break;
                }
                try printValue(out, x, max_len);
            }
            try out.writeAll("]");
        },
        .object => |o| try out.print("{{{d} keys}}", .{o.count()}),
    }
}

test "diff reports changed, reordered, added and removed leaves grouped by section" {
    const a =
        \\{"tls":{"ja4":"t13d1516h2_aaaa_bbbb","cipher_suites":["1301","1302"],"extensions":["0000","0010","002b"],"key_share_groups":["11ec","001d"]},
        \\ "http2":{"settings":[["1",65536],["2",0]],"window_update":15663105},
        \\ "http":{"headers_order":["host","user-agent"]}}
    ;
    const b =
        \\{"tls":{"ja4":"t13d1516h2_aaaa_cccc","cipher_suites":["1301","1302"],"extensions":["002b","0000","0010"],"key_share_groups":["11ec","001d","0017"]},
        \\ "http2":{"settings":[["1",65536],["2",0]],"window_update":15663105},
        \\ "http":{"headers_order":["host","user-agent"],"priority":"u=0, i"},
        \\ "tcp":{"window_size":65535}}
    ;
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const va = try std.json.parseFromSliceLeaky(Value, arena, a, .{});
    const vb = try std.json.parseFromSliceLeaky(Value, arena, b, .{});
    const r = try compare(arena, va, vb, .{});
    try std.testing.expect(!r.normalized); // not reports: no tls.client_hello
    var buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try writeText(&w, r, .{});
    const text = w.buffered();
    try std.testing.expectEqual(@as(usize, 2), r.stats.changed); // ja4 value, key_share_groups set
    try std.testing.expectEqual(@as(usize, 1), r.stats.reordered); // extensions: same set, new order
    try std.testing.expect(r.stats.added >= 2); // http.priority, tcp section
    try std.testing.expect(std.mem.indexOf(u8, text, "extensions") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "reordered") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "+0017") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "t13d1516h2_aaaa_bbbb -> t13d1516h2_aaaa_cccc") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "tcp") != null);
}

test "SETTINGS pairs are one field: changed as a list, reordered when only the order differs" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // Chrome's and httpx's SETTINGS (0.4-W2 research report), then Chrome's in another order.
    const chrome = try std.json.parseFromSliceLeaky(Value, arena, "{\"http2\":{\"settings\":[[1,65536],[2,0],[4,6291456],[6,262144]]}}", .{});
    const httpx = try std.json.parseFromSliceLeaky(Value, arena, "{\"http2\":{\"settings\":[[1,4096],[2,0],[4,65535],[5,16384],[3,100],[6,65536]]}}", .{});
    const shuffled = try std.json.parseFromSliceLeaky(Value, arena, "{\"http2\":{\"settings\":[[2,0],[1,65536],[4,6291456],[6,262144]]}}", .{});
    const r = try compare(arena, chrome, httpx, .{});
    try std.testing.expectEqual(@as(usize, 1), r.differences.len);
    try std.testing.expectEqualStrings("http2.settings", r.differences[0].path);
    try std.testing.expectEqual(Kind.changed, r.differences[0].kind);
    const s = try compare(arena, chrome, shuffled, .{});
    try std.testing.expectEqual(@as(usize, 1), s.differences.len);
    try std.testing.expectEqual(Kind.reordered, s.differences[0].kind);
}

test "equal treats 1 and 1.0 alike and compares objects by key" {
    var pa = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"a\":1,\"b\":[1,2]}", .{});
    defer pa.deinit();
    var pb = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"b\":[1,2],\"a\":1.0}", .{});
    defer pb.deinit();
    try std.testing.expect(equal(pa.value, pb.value));
}

test "report normalisation: GREASE-only and PSK-only differences vanish, the psk label remains" {
    // Shapes of two Chrome reports (values abbreviated; GREASE drawn per connection, order permuted).
    const a =
        \\{"connection":{"peer":"127.0.0.1:1"},"tls":{"handshake":{"alpn":"h2","session_reused":false},
        \\ "client_hello":{"random":"aa","session_id":"bb","cipher_suites":["eaea","1301"],"extensions_order":["fafa","0000","0010","aaaa"],
        \\   "extension_grease_positions":[0,3],"supported_groups":["1a1a","11ec"],"key_shares":[{"group":"1a1a","key_exchange_length":1},{"group":"11ec","key_exchange_length":1216}],
        \\   "has_pre_shared_key":false,"message_length":1950},
        \\ "ja3":{"hash":"x"},"ja4":{"ja4":"t13d0201h2_a_b","ja4_r":"r1","ja4_o":"o1","ja4_ro":"ro1"}}}
    ;
    const b =
        \\{"connection":{"peer":"127.0.0.1:2"},"tls":{"handshake":{"alpn":"h2","session_reused":true},
        \\ "client_hello":{"random":"cc","session_id":"dd","cipher_suites":["9a9a","1301"],"extensions_order":["2a2a","0010","0000","3a3a","0029"],
        \\   "extension_grease_positions":[0,3],"supported_groups":["5a5a","11ec"],"key_shares":[{"group":"5a5a","key_exchange_length":1},{"group":"11ec","key_exchange_length":1216}],
        \\   "has_pre_shared_key":true,"message_length":2100},
        \\ "ja3":{"hash":"y"},"ja4":{"ja4":"t13d0202h2_a_c","ja4_r":"r2","ja4_o":"o2","ja4_ro":"ro2"}}}
    ;
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const va = try std.json.parseFromSliceLeaky(Value, arena, a, .{});
    const vb = try std.json.parseFromSliceLeaky(Value, arena, b, .{});
    const r = try compare(arena, va, vb, .{});
    try std.testing.expect(r.normalized);
    try std.testing.expectEqual(@as(usize, 0), r.differences.len);
    try std.testing.expectEqual(@as(usize, 1), r.labels.len);
    try std.testing.expectEqualStrings("psk", r.labels[0].label);
    // The inputs are untouched.
    try std.testing.expectEqualStrings("eaea", get(va, &.{ "tls", "client_hello" }).?.object.get("cipher_suites").?.array.items[0].string);
    // Raw comparison sees the noise.
    const raw = try compare(arena, va, vb, .{ .normalize = false });
    try std.testing.expect(raw.differences.len > 5);
}
