//! wireprint executable: real argv, files and stdio around `cli.run` (src/cli.zig holds every command,
//! the usage text and the exit codes: 0 ok, 1 usage or input error, 3 check INCONSISTENT).
const std = @import("std");
const wireprint = @import("wireprint");

const Files = struct {
    io: std.Io,

    fn read(ptr: *anyopaque, gpa: std.mem.Allocator, path: []const u8) anyerror![]u8 {
        const self: *Files = @ptrCast(@alignCast(ptr));
        return std.Io.Dir.cwd().readFileAlloc(self.io, path, gpa, .unlimited);
    }
};

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;

    var stdout_buf: [16 * 1024]u8 = undefined;
    var stdout_w = std.Io.File.stdout().writer(io, &stdout_buf);
    var stderr_buf: [4 * 1024]u8 = undefined;
    var stderr_w = std.Io.File.stderr().writer(io, &stderr_buf);

    // iterateAllocator, not iterate: the plain iterator is a compile error on Windows.
    var it = try init.minimal.args.iterateAllocator(gpa);
    defer it.deinit();
    _ = it.skip();
    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(gpa);
    while (it.next()) |a| try args.append(gpa, a);

    var files: Files = .{ .io = io };
    const code = wireprint.cli.run(.{
        .gpa = gpa,
        .out = &stdout_w.interface,
        .err = &stderr_w.interface,
        .files = .{ .ptr = &files, .readFn = Files.read },
    }, args.items);
    std.process.exit(code);
}
