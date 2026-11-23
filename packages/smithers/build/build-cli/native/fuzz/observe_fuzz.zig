const std = @import("std");
extern fn fuzz_observe_escaped(s: [*]const u8, n: usize, angled: c_int, out: [*]u8, cap: usize) usize;
extern fn fuzz_observe_key_of(name: [*:0]const u8, out: [*]u8, cap: usize) void;
extern fn fuzz_observe_part_of(s: [*:0]const u8, start_offset: *usize) usize;
extern fn fuzz_observe_number_of(part: [*]const u8, len: usize, val_out: *c_long) c_int;
extern fn fuzz_observe_pseudo(path: [*:0]const u8) c_int;
extern fn fuzz_observe_full_hash(name: [*:0]const u8) u64;
extern fn fuzz_observe_errno_name(err: c_int) ?[*:0]const u8;

test "regression: observe.c keyOf respects capacity 0 and 1 without buffer overflow" {
    var out: [8]u8 = @splat(0xAA);
    fuzz_observe_key_of("/", &out, 0);
    for (out) |b| try std.testing.expectEqual(@as(u8, 0xAA), b);

    fuzz_observe_key_of("/", &out, 1);
    try std.testing.expectEqual(@as(u8, 0), out[0]);
    for (out[1..]) |b| try std.testing.expectEqual(@as(u8, 0xAA), b);
}

test "fuzz observe.c escaped, keyOf, partOf, numberOf, pseudo, fullHash, errnoName" {
    try std.testing.fuzz({}, struct {
        fn testOne(_: void, smith: *std.testing.Smith) !void {
            var in_buf: [256]u8 = undefined;
            const n = smith.slice(&in_buf);
            const angled: c_int = if (smith.value(bool)) 1 else 0;
            const cap = smith.valueRangeAtMost(u16, 0, 260);
            const err_num = smith.value(i32);

            // 1. escaped: NUL-terminated printable ASCII, no raw quotes/newlines/angles, bounded by 4*n
            var out_buf: [2048]u8 = undefined;
            const written = fuzz_observe_escaped(&in_buf, n, angled, &out_buf, out_buf.len);
            const checked = @min(written, out_buf.len - 1);
            try std.testing.expectEqual(@as(u8, 0), out_buf[checked]);
            for (out_buf[0..checked]) |ch| {
                try std.testing.expect(ch >= 0x20 and ch < 0x7f);
                if (angled != 0) {
                    try std.testing.expect(ch != '<' and ch != '>');
                }
            }
            try std.testing.expect(written <= n * 4);

            // Prepare NUL-terminated path slice without embedded NULs
            var zbuf: [257]u8 = undefined;
            for (0..n) |i| {
                zbuf[i] = if (in_buf[i] == 0) '/' else in_buf[i];
            }
            zbuf[n] = 0;
            const path: [*:0]const u8 = zbuf[0..n :0];

            // 2. keyOf: canary-checked buffer bounds for cap 0..260 + idempotency
            var kout: [264]u8 = @splat(0xAA);
            fuzz_observe_key_of(path, &kout, cap);
            for (cap..kout.len) |i| {
                try std.testing.expectEqual(@as(u8, 0xAA), kout[i]);
            }
            if (cap > 0) {
                const out_slice = std.mem.sliceTo(kout[0..cap], 0);
                try std.testing.expect(out_slice.len < cap);
            }
            var full1: [512]u8 = undefined;
            var full2: [512]u8 = undefined;
            fuzz_observe_key_of(path, &full1, full1.len);
            const s1 = std.mem.sliceTo(&full1, 0);
            fuzz_observe_key_of(full1[0..s1.len :0], &full2, full2.len);
            const s2 = std.mem.sliceTo(&full2, 0);
            try std.testing.expectEqualStrings(s1, s2);
            try std.testing.expect(std.mem.indexOf(u8, s1, "//") == null);
            if (s1.len > 1) {
                try std.testing.expect(s1[s1.len - 1] != '/');
            }

            // 3. partOf: never walks past NUL
            var off: usize = 0;
            const plen = fuzz_observe_part_of(path, &off);
            try std.testing.expect(off <= n);
            try std.testing.expect(off + plen <= n);

            // 4. numberOf: exact decimal parsing for 1..9 ASCII digits
            var val: c_long = -1;
            const ok = fuzz_observe_number_of(&in_buf, n, &val);
            var expected_ok = n >= 1 and n <= 9;
            var expected_val: c_long = 0;
            if (expected_ok) {
                for (in_buf[0..n]) |ch| {
                    if (ch < '0' or ch > '9') {
                        expected_ok = false;
                        break;
                    }
                    expected_val = expected_val * 10 + @as(c_long, ch - '0');
                }
            }
            try std.testing.expectEqual(@as(c_int, if (expected_ok) 1 else 0), ok);
            if (expected_ok) {
                try std.testing.expectEqual(expected_val, val);
            }

            // 5. pseudo: exact /proc, /dev, /sys prefixes
            const p = fuzz_observe_pseudo(path);
            const slice = zbuf[0..n];
            const is_pseudo =
                (std.mem.startsWith(u8, slice, "/proc") and (slice.len == 5 or slice[5] == '/')) or
                (std.mem.startsWith(u8, slice, "/dev") and (slice.len == 4 or slice[4] == '/')) or
                (std.mem.startsWith(u8, slice, "/sys") and (slice.len == 4 or slice[4] == '/'));
            try std.testing.expectEqual(@as(c_int, if (is_pseudo) 1 else 0), p);

            // 6. fullHash: exact FNV-1a 64-bit
            var h: u64 = 1469598103934665603;
            for (slice) |ch| {
                h = (h ^ ch) *% 1099511628211;
            }
            try std.testing.expectEqual(h, fuzz_observe_full_hash(path));

            // 7. errnoName: never crashes on arbitrary i32
            _ = fuzz_observe_errno_name(err_num);
        }
    }.testOne, .{
        .corpus = &.{
            "hello world",
            "line1\nline2\r\t\"\\<>/proc/self/fd/3",
            "\x00\x01\x0b\x0c\x7f\x80\xff",
            "/",
            "///",
            "/././",
            "/a//b/./c/",
            "/proc/self/fd/0",
            "/process/123",
            "/dev/null",
            "/sys/kernel",
            "123456789",
            "1234567890",
        },
    });
}
