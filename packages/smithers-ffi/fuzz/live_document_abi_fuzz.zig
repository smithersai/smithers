const std = @import("std");

const LdResult = extern struct {
    data: ?[*]u8,
    len: usize,
    status: u32,
};

extern fn ld_open(kind: u32, state: ?[*]const u8, len: usize) u64;
extern fn ld_apply(h: u64, client: u64, update: ?[*]const u8, len: usize) LdResult;
extern fn ld_peer(h: u64, update: ?[*]const u8, len: usize) LdResult;
extern fn ld_sync1(h: u64) LdResult;
extern fn ld_sync2(h: u64, sv: ?[*]const u8, len: usize) LdResult;
extern fn ld_awareness(h: u64, bytes: ?[*]const u8, len: usize) LdResult;
extern fn ld_set_author(h: u64, client: u64, actor: ?[*]const u8, len: usize) LdResult;
extern fn ld_state(h: u64) LdResult;
extern fn ld_text(h: u64, root: ?[*]const u8, len: usize) LdResult;
extern fn ld_close(h: u64) LdResult;
extern fn ld_free(result: LdResult) void;

test "fuzz live_document C ABI across arbitrary binary inputs and state transitions" {
    try std.testing.fuzz({}, struct {
        fn testOne(_: void, smith: *std.testing.Smith) !void {
            const kind: u32 = if (smith.value(bool)) 0 else 1;
            const h = ld_open(kind, null, 0);
            try std.testing.expect(h != 0);
            defer {
                const closed = ld_close(h);
                ld_free(closed);
            }

            const actor = "fuzz-author";
            const auth = ld_set_author(h, 7, actor.ptr, actor.len);
            try std.testing.expect(auth.status == 0);
            ld_free(auth);

            var buf: [256]u8 = undefined;
            const steps = smith.valueRangeAtMost(u8, 1, 12);
            for (0..steps) |_| {
                const op = smith.valueRangeAtMost(u8, 0, 6);
                const n = smith.slice(&buf);
                const ptr: ?[*]const u8 = if (n == 0) null else &buf;
                const res: LdResult = switch (op) {
                    0 => ld_apply(h, 7, ptr, n),
                    1 => blk: {
                        // Unregistered client must never return ok (0)
                        const r = ld_apply(h, 99999, ptr, n);
                        try std.testing.expect(r.status != 0);
                        break :blk r;
                    },
                    2 => ld_peer(h, ptr, n),
                    3 => ld_sync2(h, ptr, n),
                    4 => ld_awareness(h, ptr, n),
                    5 => ld_text(h, ptr, n),
                    else => blk: {
                        const s1 = ld_sync1(h);
                        try std.testing.expect(s1.status == 0);
                        ld_free(s1);
                        break :blk ld_state(h);
                    },
                };
                // C ABI must NEVER panic (status == 3)
                try std.testing.expect(res.status != 3);
                ld_free(res);
            }
        }
    }.testOne, .{
        .corpus = &.{
            "\x00\x00\x00",
            "\x81\x80\x80\x80\x10\x00",
            "\xff\xff\xff\xff\x0f",
        },
    });
}
