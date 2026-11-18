const tone = @import("tone.zig");

pub fn greeting() []const u8 {
    return tone.word;
}
