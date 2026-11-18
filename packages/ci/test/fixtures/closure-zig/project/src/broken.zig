const missing = @import("missing.zig");

test "broken cannot compile" {
    _ = missing;
}
