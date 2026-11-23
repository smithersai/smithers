/** The disk under a replay: the floor it leaves free, the watch that keeps jobs to it, and the real readers. */
import * as Deferred from "effect/Deferred"
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
    expect(await heldUnder(root, AbortSignal.abort())).toBe(0)
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
  it("signals the emergency before reading sizes and shares one diagnostic across callers", async () => {
    const walked: Array<string> = []
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const watch = yield* diskWatch("/replay", "/replay/jobs", () => Effect.void, tick)
        yield* Effect.flip(watch.ended)
        expect(yield* watch.most).toBe(0)
        expect(walked).toEqual([])
        return yield* Effect.all([watch.stopped, watch.stopped], { concurrency: "unbounded" })
      })).pipe(Effect.provideService(DiskSpace, {
        space: () => Effect.succeed({ free: gb(1), total: gb(100) }),
        held: (path) =>
          Effect.sync(() => {
            walked.push(path)
            return gb(1)
          })
      }))
    )
    expect(result[0]).toBe(result[1])
    expect(walked).toEqual(["/replay", "/replay/jobs"])
  })

  it.each(["admission", "cleanup", "watchdog"] as const)(
    "shares the stop while %s is waiting for a disk read",
    async (stage) => {
      let reads = 0
      await Effect.runPromise(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const blockedRead = stage === "cleanup" ? 3 : 2
        yield* Effect.scoped(Effect.gen(function*() {
          const watch = yield* diskWatch("/replay", "/replay/jobs", () => Effect.void, "50 millis")
          if (stage === "watchdog") yield* Deferred.await(entered)
          const job = yield* Effect.forkChild(Effect.flip(watch.admit(Effect.void)))
          yield* Deferred.await(entered)
          const stopped = yield* Effect.flip(watch.ended)
          yield* Deferred.succeed(resume, undefined)
          expect(yield* Fiber.join(job)).toEqual(stopped)
          yield* Effect.sleep("60 millis")
        })).pipe(Effect.provideService(DiskSpace, {
          space: () =>
            Effect.gen(function*() {
              const read = ++reads
              if (read === blockedRead) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(resume)
              }
              return { total: gb(100), free: gb(read >= blockedRead ? 1 : 4) }
            }),
          held: () => Effect.succeed(0)
        }))
      }))
    }
  )

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
    expect(most).toBe(gb(7))
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
    // Another process can fill the disk. Only the replay directory's own allocation counts.
    expect(most).toBe(gb(7))
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
    const failed = { code: "command-failed", message: line.split(" (5 GB,")[0], part: "replay" }
    expect(outcome.first).toEqual(failed)
    expect(outcome.later).toEqual(failed)
    expect(outcome.ended).toEqual(failed)
    expect(outcome.stopped).toBe(line)
    expect(line).toBe(
      "the replay stopped before the disk filled: the disk that holds /replay has 4.0 GB free, under the 5.0 GB a " +
        "replay leaves free (5 GB, or 2% of the disk when that is more); the replay held 7 GB there, 7 GB of it in " +
        "its jobs' machines. Run it with fewer jobs at once (--jobs) or with more free space"
    )
  })

  it("says free space under the floor so that it reads as under, and advises only what gives room back", () => {
    // Rounded alike, 4.97 GB and 5 GB would read "5 GB free, under the 5 GB": what is free is rounded down and the
    // floor up, so the line never says the one is under the other when the numbers it shows are equal.
    expect(stoppedLine("/replay", gb(4.97), gb(5), gb(0), gb(0))).toBe(
      "the replay stopped before the disk filled: the disk that holds /replay has 4.9 GB free, under the 5.0 GB a " +
        "replay leaves free (5 GB, or 2% of the disk when that is more); the replay held 0 GB there, 0 GB of it in " +
        "its jobs' machines. Free 0.1 GB more on that disk, or set TMPDIR to a folder on a disk with more room"
    )
    expect(stoppedLine("/replay", gb(4.99999), gb(5), gb(0), gb(0))).toContain("has 4.9 GB free, under the 5.0 GB")
    // A floor of 2% of a large disk is said in whole gigabytes, and so is a large shortfall.
    expect(stoppedLine("/replay", gb(25.7), gb(37.2), gb(1), gb(0.05))).toContain(
      "has 25 GB free, under the 38 GB a replay leaves free"
    )
    expect(stoppedLine("/replay", gb(25), gb(38), gb(1), gb(0.05))).toContain("Free 13 GB more on that disk")
    expect(stoppedLine("/replay", gb(3), gb(5), gb(1), gb(0.05))).toContain("Free 2.0 GB more on that disk")
    expect(waitingLine(gb(4.97), gb(5))).toBe(
      "waiting for disk space: 4.9 GB free, under the 5.0 GB a replay leaves free; no job starts until a running one ends"
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
      {
        code: "command-failed",
        message: stoppedLine("/replay", gb(2), gb(5), gb(7), gb(7)).split(" (5 GB,")[0],
        part: "replay"
      }
    )
  })
})
