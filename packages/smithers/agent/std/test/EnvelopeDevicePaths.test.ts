/**
 * `/dev` is not all process plumbing. The pre-check used to skip every path
 * under it, so `cat secret > /dev/shm/x` passed with no declared write:
 * `/dev/shm` is a writable filesystem and a block device is a disk.
 */
import { Effect, Path } from "effect"
import { describe, expect, it } from "vitest"
import { outsideEnvelope } from "../src/internal/EnvelopePrecheck.ts"

const path = Effect.runSync(Effect.provide(
  Effect.gen(function*() {
    return yield* Path.Path
  }),
  Path.layer
))

const envelope = { reads: ["/work/**"], writes: [] as ReadonlyArray<string> }

describe("device paths in the hermetic pre-check", () => {
  it.each([
    "cat /work/a > /dev/null",
    "cat /work/a 2>/dev/null",
    "head -c 16 /dev/zero",
    "head -c 16 /dev/urandom",
    "head -c 16 /dev/random",
    "cat /work/a > /dev/full",
    "cat /dev/stdin",
    "cat /work/a > /dev/stdout",
    "cat /work/a > /dev/stderr",
    "cat /work/a > /dev/tty",
    "cat /dev/fd/3",
    "cat /work/a > /dev/fd/12"
  ])("admits process plumbing: %s", (text) => {
    expect(outsideEnvelope(envelope, text, path)).toBeUndefined()
  })

  it.each([
    ["cat /work/secret > /dev/shm/x", "outside_declared_writes", "/dev/shm/x"],
    ["cat /dev/shm/x", "outside_declared_reads", "/dev/shm/x"],
    ["cat /work/a > /dev/sda", "outside_declared_writes", "/dev/sda"],
    ["cat /dev/mem", "outside_declared_reads", "/dev/mem"],
    ["cat /work/a > /dev/fd/../shm/x", "outside_declared_writes", "/dev/shm/x"],
    ["cat /work/a > /dev/null/x", "outside_declared_writes", "/dev/null/x"],
    ["cat /dev/fd/x", "outside_declared_reads", "/dev/fd/x"]
  ])("refuses an undeclared device path: %s", (text, code, refused) => {
    expect(outsideEnvelope(envelope, text, path)).toMatchObject({ code, path: refused })
  })

  it("admits a /dev/shm path the caller declared", () => {
    expect(
      outsideEnvelope({ reads: ["/work/**"], writes: ["/dev/shm/**"] }, "cat /work/a > /dev/shm/x", path)
    ).toBeUndefined()
  })
})
