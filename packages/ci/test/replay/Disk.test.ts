/** The disk under a replay: the floor it leaves free, the watch that keeps jobs to it, and the real readers. */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DiskSpace, type DiskWatch, diskWatch, floorOf, stoppedLine, waitingLine } from "../../src/replay/Disk.vibe"
import { gigabyte, heldUnder, sizeOf, spaceOf } from "../../src/replay/DiskSpace.ts"
import { setDisk } from "./SmallDisk.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "disk-"))
  created.push(root)
  return root
}

const gb = (n: number): number => n * gigabyte
const tick = "10 millis"

/** Runs `body` with a watch of a 100 GB disk whose free space `free` holds and whose folder holds 7 GB, 6 GB of it in machines. */
const watching = <A, E>(
  free: Ref.Ref<number | undefined>,
  said: Array<string>,
  body: (watch: DiskWatch) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        diskWatch("/replay", "/replay/machines", (line) => Effect.sync(() => void said.push(line)), tick),
        body
      )
    ).pipe(Effect.provide(setDisk(free, gb(7)))) as Effect.Effect<A, E>
  )

describe("the floor a replay leaves free", () => {
  it("is 5 GB, or 2% of the disk when that is more", () => {
    expect(floorOf(gb(100))).toBe(gb(5))
    expect(floorOf(gb(1000))).toBe(gb(20))
  })

  it("is written as a person reads a size", () => {
    expect(sizeOf(gb(47.4))).toBe("47 GB")
    expect(sizeOf(gb(3.24))).toBe("3.2 GB")
    expect(sizeOf(-1)).toBe("0 GB")
  })
})

describe("the disk as the machine says it is", () => {
  it("has a size and free space where a folder is", async () => {
    const space = await spaceOf(tmpdir())
    expect(space.total).toBeGreaterThan(0)
    expect(space.free).toBeGreaterThanOrEqual(0)
    expect(space.free).toBeLessThanOrEqual(space.total)
  })

  it("says nothing where there is no folder", async () => {
    const said = await Effect.runPromise(Effect.gen(function*() {
      const disk = yield* DiskSpace
      return yield* disk.space("/no/such/folder")
    }))
    expect(said).toBeUndefined()
  })

  it("counts each file under a folder once, and nothing it cannot read", async () => {
    const root = scratch()
    writeFileSync(join(root, "a"), "x".repeat(100_000))
    linkSync(join(root, "a"), join(root, "b"))
    mkdirSync(join(root, "closed"))
    writeFileSync(join(root, "closed", "c"), "x".repeat(100_000))
    chmodSync(join(root, "closed"), 0o000)
    const held = await Effect.runPromise(Effect.gen(function*() {
      const disk = yield* DiskSpace
      return yield* disk.held(root)
    }))
    chmodSync(join(root, "closed"), 0o700)
    expect(held).toBeGreaterThanOrEqual(100_000)
    expect(held).toBeLessThan(200_000)
    expect(await heldUnder(join(root, "missing"))).toBe(0)
  })
})

describe("a watch of the disk", () => {
  it("lets every job start, and says no number, where the machine does not say what is free", async () => {
    const free = Effect.runSync(Ref.make<number | undefined>(undefined))
    const said: Array<string> = []
    const most = await watching(free, said, (watch) =>
      Effect.gen(function*() {
        yield* watch.admit(Effect.void)
        yield* watch.admit(Effect.void)
        return yield* watch.most
      }))
    expect(most).toBeUndefined()
    expect(said).toEqual([])
  })

  it("keeps what it last read when the machine stops saying what is free", async () => {
    const free = Effect.runSync(Ref.make<number | undefined>(gb(20)))
    const most = await watching(free, [], (watch) =>
      Effect.gen(function*() {
        yield* watch.admit(Effect.void)
        yield* Ref.set(free, undefined)
        yield* Effect.sleep("50 millis")
        yield* watch.admit(Effect.void)
        return yield* watch.most
      }))
    expect(most).toBe(0)
  })

  it("holds a job while the disk is under the floor and another runs, and starts it when space comes back", async () => {
    const free = Effect.runSync(Ref.make<number | undefined>(gb(20)))
    const said: Array<string> = []
    const most = await watching(free, said, (watch) =>
      Effect.gen(function*() {
        yield* watch.admit(Effect.void)
        yield* Ref.set(free, gb(4))
        const admitted = yield* Ref.make(false)
        const second = yield* Effect.forkChild(Effect.andThen(watch.admit(Effect.void), Ref.set(admitted, true)))
        yield* Effect.sleep("200 millis")
        expect(yield* Ref.get(admitted)).toBe(false)
        yield* watch.release
        yield* Ref.set(free, gb(12))
        yield* Fiber.join(second)
        return yield* watch.most
      }))
    // Said once however long it waited.
    expect(said).toEqual([waitingLine(gb(4), gb(5))])
    expect(most).toBe(gb(16))
  })

  it("removes what finished jobs left when none runs, and starts the job when that made room", async () => {
    const free = Effect.runSync(Ref.make<number | undefined>(gb(4)))
    const said: Array<string> = []
    const stopped = await watching(free, said, (watch) =>
      Effect.gen(function*() {
        yield* watch.admit(Ref.set(free, gb(9)))
        return yield* watch.stopped
      }))
    expect(stopped).toBeUndefined()
    expect(said).toEqual([])
  })

  it("stops the replay with one line when no room comes back, and every later job with it", async () => {
    const free = Effect.runSync(Ref.make<number | undefined>(gb(4)))
    const line = stoppedLine("/replay", gb(4), gb(5), gb(7), gb(7))
    const outcome = await watching(free, [], (watch) =>
      Effect.gen(function*() {
        const first = yield* Effect.flip(watch.admit(Effect.void))
        const later = yield* Effect.flip(watch.admit(Effect.void))
        const ended = yield* Effect.flip(watch.ended)
        return { first, later, ended, stopped: yield* watch.stopped }
      }))
    const failed = { code: "command-failed", message: line, part: "replay" }
    expect(outcome.first).toEqual(failed)
    expect(outcome.later).toEqual(failed)
    expect(outcome.ended).toEqual(failed)
    expect(outcome.stopped).toBe(line)
    expect(line).toBe(
      "the replay stopped before the disk filled: the disk that holds /replay has 4 GB free, under the 5 GB a " +
        "replay leaves free (5 GB, or 2% of the disk when that is more); the replay held 7 GB there, 7 GB of it in " +
        "its jobs' machines. Run it with fewer jobs at once (--jobs) or with more free space"
    )
  })

  it("ends what runs when the free space falls under half the floor", async () => {
    const free = Effect.runSync(Ref.make<number | undefined>(gb(20)))
    const ended = await watching(free, [], (watch) =>
      Effect.gen(function*() {
        yield* watch.admit(Effect.void)
        yield* Ref.set(free, gb(2))
        return yield* Effect.flip(watch.ended)
      }))
    expect(ended).toEqual(
      { code: "command-failed", message: stoppedLine("/replay", gb(2), gb(5), gb(7), gb(7)), part: "replay" }
    )
  })
})
