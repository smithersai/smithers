const std = @import("std");
const greet = @import("greet");
const shared = @import("shared.zig");

const motto = @embedFile("alpha.txt");

test "alpha reads the shared file, the embedded file and the package" {
    try std.testing.expectEqual(4, shared.double(2));
    try std.testing.expectEqualStrings("alpha\n", motto);
    try std.testing.expectEqualStrings("hello", greet.greeting());
}
