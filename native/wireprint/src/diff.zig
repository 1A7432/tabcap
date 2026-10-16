//! `wireprint diff a.json b.json`: human-readable diff of two JSON documents grouped by top-level
//! key (the profile layers: tls / http2 / http / tcp / ...). Works on any JSON so it can compare two `parse`
//! reports, two corpus profiles, or a real profile against an impersonation library's output.
//! Output format (one line per leaf that differs):
//!   <section>
//!     <path>            unchanged | <a> -> <b> | +<b> (only in b) | -<a> (only in a)
//! Arrays of scalars are compared as sets AND as sequences: "same set, different order" is reported as
//! `reordered`, which is exactly the Chrome extension-permutation case.
const std = @import("std");
const Value = std.json.Value;

pub const Options = struct {
    /// Print unchanged leaves too.
    verbose: bool = false,
    /// Maximum characters printed for a scalar value.
    max_value_len: usize = 72,
};

pub const Stats = struct { changed: usize = 0, added: usize = 0, removed: usize = 0, reordered: usize = 0, unchanged: usize = 0 };

pub fn diffText(gpa: std.mem.Allocator, out: *std.Io.Writer, a_text: []const u8, b_text: []const u8, opts: Options) !Stats {
    var pa = try std.json.parseFromSlice(Value, gpa, a_text, .{});
    defer pa.deinit();
    var pb = try std.json.parseFromSlice(Value, gpa, b_text, .{});
    defer pb.deinit();
    return diffValues(gpa, out, pa.value, pb.value, opts);
}

pub fn diffValues(gpa: std.mem.Allocator, out: *std.Io.Writer, a: Value, b: Value, opts: Options) !Stats {
    var stats: Stats = .{};
    if (a != .object or b != .object) {
        var path_buf: std.ArrayList(u8) = .empty;
        defer path_buf.deinit(gpa);
        try diffNode(gpa, out, &path_buf, a, b, opts, &stats);
        return stats;
    }
    // Top-level keys are sections; print each header once, then its leaves indented.
    var keys: std.ArrayList([]const u8) = .empty;
    defer keys.deinit(gpa);
    try collectKeys(gpa, &keys, a.object, b.object);
    for (keys.items) |k| {
        const av = a.object.get(k);
        const bv = b.object.get(k);
        try out.print("{s}\n", .{k});
        var path_buf: std.ArrayList(u8) = .empty;
        defer path_buf.deinit(gpa);
        try path_buf.appendSlice(gpa, "  ");
        if (av != null and bv != null) {
            try diffNode(gpa, out, &path_buf, av.?, bv.?, opts, &stats);
        } else if (bv != null) {
            try out.print("  +{s}\n", .{k});
            stats.added += 1;
        } else {
            try out.print("  -{s}\n", .{k});
            stats.removed += 1;
        }
    }
    return stats;
}

fn collectKeys(gpa: std.mem.Allocator, keys: *std.ArrayList([]const u8), a: std.json.ObjectMap, b: std.json.ObjectMap) !void {
    var it = a.iterator();
    while (it.next()) |e| try keys.append(gpa, e.key_ptr.*);
    var itb = b.iterator();
    while (itb.next()) |e| {
        if (a.get(e.key_ptr.*) == null) try keys.append(gpa, e.key_ptr.*);
    }
}

fn diffNode(gpa: std.mem.Allocator, out: *std.Io.Writer, path: *std.ArrayList(u8), a: Value, b: Value, opts: Options, stats: *Stats) !void {
    if (a == .object and b == .object) {
        var keys: std.ArrayList([]const u8) = .empty;
        defer keys.deinit(gpa);
        try collectKeys(gpa, &keys, a.object, b.object);
        for (keys.items) |k| {
            const mark = path.items.len;
            defer path.shrinkRetainingCapacity(mark);
            if (path.items.len > 2) try path.append(gpa, '.');
            try path.appendSlice(gpa, k);
            const av = a.object.get(k);
            const bv = b.object.get(k);
            if (av != null and bv != null) {
                try diffNode(gpa, out, path, av.?, bv.?, opts, stats);
            } else if (bv != null) {
                try out.print("{s: <28} +", .{path.items});
                try printValue(out, bv.?, opts.max_value_len);
                try out.writeAll("\n");
                stats.added += 1;
            } else {
                try out.print("{s: <28} -", .{path.items});
                try printValue(out, av.?, opts.max_value_len);
                try out.writeAll("\n");
                stats.removed += 1;
            }
        }
        return;
    }
    if (a == .array and b == .array and isScalarArray(a.array) and isScalarArray(b.array)) {
        if (equal(a, b)) {
            stats.unchanged += 1;
            if (opts.verbose) try out.print("{s: <28} unchanged ({d})\n", .{ path.items, a.array.items.len });
            return;
        }
        if (sameSet(a.array, b.array)) {
            stats.reordered += 1;
            try out.print("{s: <28} reordered (same {d} values, different order)\n", .{ path.items, a.array.items.len });
            return;
        }
        stats.changed += 1;
        try out.print("{s: <28} ", .{path.items});
        // Set difference, which is what a reader wants for cipher / extension lists.
        var printed = false;
        for (b.array.items) |bv| {
            if (!contains(a.array, bv)) {
                try out.writeAll(if (printed) " " else "");
                try out.writeAll("+");
                try printValue(out, bv, opts.max_value_len);
                printed = true;
            }
        }
        for (a.array.items) |av| {
            if (!contains(b.array, av)) {
                try out.writeAll(if (printed) " " else "");
                try out.writeAll("-");
                try printValue(out, av, opts.max_value_len);
                printed = true;
            }
        }
        if (!printed) try out.print("({d} -> {d} values, duplicates differ)", .{ a.array.items.len, b.array.items.len });
        try out.writeAll("\n");
        return;
    }
    if (a == .array and b == .array) {
        // Arrays of objects/arrays: compare element-wise by index.
        const n = @max(a.array.items.len, b.array.items.len);
        var i: usize = 0;
        while (i < n) : (i += 1) {
            const mark = path.items.len;
            defer path.shrinkRetainingCapacity(mark);
            try path.print(gpa, "[{d}]", .{i});
            if (i < a.array.items.len and i < b.array.items.len) {
                try diffNode(gpa, out, path, a.array.items[i], b.array.items[i], opts, stats);
            } else if (i < b.array.items.len) {
                try out.print("{s: <28} +", .{path.items});
                try printValue(out, b.array.items[i], opts.max_value_len);
                try out.writeAll("\n");
                stats.added += 1;
            } else {
                try out.print("{s: <28} -", .{path.items});
                try printValue(out, a.array.items[i], opts.max_value_len);
                try out.writeAll("\n");
                stats.removed += 1;
            }
        }
        return;
    }
    if (equal(a, b)) {
        stats.unchanged += 1;
        if (opts.verbose) {
            try out.print("{s: <28} unchanged ", .{path.items});
            try printValue(out, a, opts.max_value_len);
            try out.writeAll("\n");
        }
        return;
    }
    stats.changed += 1;
    try out.print("{s: <28} ", .{path.items});
    try printValue(out, a, opts.max_value_len);
    try out.writeAll(" -> ");
    try printValue(out, b, opts.max_value_len);
    try out.writeAll("\n");
}

fn isScalarArray(arr: std.json.Array) bool {
    for (arr.items) |v| switch (v) {
        .object, .array => return false,
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

fn printValue(out: *std.Io.Writer, v: Value, max_len: usize) !void {
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
    var buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    const stats = try diffText(std.testing.allocator, &w, a, b, .{});
    const text = w.buffered();
    try std.testing.expectEqual(@as(usize, 2), stats.changed); // ja4 value, key_share_groups set
    try std.testing.expectEqual(@as(usize, 1), stats.reordered); // extensions: same set, new order
    try std.testing.expect(stats.added >= 2); // http.priority, tcp section
    try std.testing.expect(std.mem.indexOf(u8, text, "extensions") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "reordered") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "+0017") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "t13d1516h2_aaaa_bbbb -> t13d1516h2_aaaa_cccc") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "tcp") != null);
}

test "equal treats 1 and 1.0 alike and compares objects by key" {
    var pa = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"a\":1,\"b\":[1,2]}", .{});
    defer pa.deinit();
    var pb = try std.json.parseFromSlice(Value, std.testing.allocator, "{\"b\":[1,2],\"a\":1.0}", .{});
    defer pb.deinit();
    try std.testing.expect(equal(pa.value, pb.value));
}
