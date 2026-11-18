const std = @import("std");
const shared = @import("shared.zig");

test "beta reads the shared file" {
    try std.testing.expectEqual(6, shared.double(3));
}
