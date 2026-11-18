const std = @import("std");
const words = @import("words");

test "gamma reads the written module" {
    try std.testing.expectEqualStrings("written", words.word);
}
