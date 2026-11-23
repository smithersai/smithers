/** The CPU time of real processes, read from this machine while they run. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { cpuWatch } from "../../src/replay/CpuWatch.vibe"
import { type Table, tableFor } from "../../src/replay/Stall.vibe"

/** Starts a shell command, counts it under a watch that reads `table` ten times a second, and gives what it saw. */
const counted = (command: string, table: Table = tableFor()): Promise<number | undefined> =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const watch = yield* cpuWatch(table, "100 millis")
      const child = spawn("sh", ["-c", command], { stdio: "ignore" })
      const ended = watch.track(child.pid as number)
      yield* Effect.promise(() => new Promise((done) => child.on("exit", done)))
      return ended()
    })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<number | undefined>
  )

// Work measured in CPU time, not in time on the clock: it takes longer on a busy machine and uses the same.
const work = "i=0; while [ $i -lt 1000000 ]; do i=$((i+1)); done"

describe("the CPU time of a running process", { timeout: 300_000 }, () => {
  it("is what the process and the processes it starts use, not the time that passes", async () => {
    const [busy, idle] = await Promise.all([counted(`sh -c '${work}' & sh -c '${work}' & wait`), counted("sleep 3")])
    expect(busy).toBeGreaterThan(300)
    expect(idle).toBeLessThan(200)
    expect(busy).toBeGreaterThan((idle as number) * 3)
  })

  it("is unknown on a machine whose processes cannot be read", async () => {
    const unread = Effect.succeed(undefined)
    const unreadable: Table = { ...tableFor(), read: unread, under: () => unread }
    expect(await counted("sleep 1", unreadable)).toBeUndefined()
  })

  it("reads the processes under a step alone, and the whole machine never, where the machine can", async () => {
    let whole = 0
    const roots: Array<number> = []
    // A machine with one process under each step, which has used 40 ms more at each reading.
    const table: Table = {
      ...tableFor(),
      read: Effect.sync(() => {
        whole += 1
        return []
      }),
      under: (root) =>
        Effect.sync(() => {
          roots.push(root)
          return [{ pid: root, parent: 1, cpuMs: roots.length * 40, ownMs: roots.length * 40, waitedMs: 0, started: 7 }]
        })
    }
    const seen = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const watch = yield* cpuWatch(table, "100 millis")
        const ended = watch.track(4242)
        yield* Effect.sleep("600 millis")
        return ended()
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<number | undefined>
    )
    expect(whole).toBe(0)
    expect(new Set(roots)).toEqual(new Set([4242]))
    expect(seen).toBe(roots.length * 40)
    // A young step is read more often than the longest time between readings allows alone: six times in 600 ms.
    expect(roots.length).toBeGreaterThan(6)
  })

  it("reads a step less often the longer it has run, down to four times a second", async () => {
    const at: Array<number> = []
    const table: Table = {
      ...tableFor(),
      under: (root) =>
        Effect.sync(() => {
          at.push(Date.now())
          return [{ pid: root, parent: 1, cpuMs: 1, ownMs: 1, waitedMs: 0, started: 7 }]
        })
    }
    const started = Date.now()
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const watch = yield* cpuWatch(table)
        watch.track(4242)
        yield* Effect.sleep("6500 millis")
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<void>
    )
    const within = (from: number, to: number): number =>
      at.filter((time) => time - started >= from && time - started < to).length
    // In its first second a step is read at least every twentieth of a second, give or take the machine's load.
    expect(within(0, 1000)).toBeGreaterThan(6)
    // After five seconds, a quarter of a second passes between two readings.
    expect(within(5400, 6400)).toBeLessThanOrEqual(5)
    expect(within(5400, 6400)).toBeGreaterThan(0)
  }, 30_000)

  it("reads every process of the machine from then on when one step's processes cannot be read alone", async () => {
    let whole = 0
    let asked = 0
    const table: Table = {
      ...tableFor(),
      read: Effect.sync(() => {
        whole += 1
        return [{ pid: 4242, parent: 1, cpuMs: 70 }]
      }),
      // A kernel that lists no process's children.
      under: () =>
        Effect.sync(() => {
          asked += 1
          return undefined
        })
    }
    const seen = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const watch = yield* cpuWatch(table, "50 millis")
        const ended = watch.track(4242)
        yield* Effect.sleep("600 millis")
        return ended()
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<number | undefined>
    )
    expect(asked).toBe(1)
    expect(whole).toBeGreaterThan(1)
    expect(seen).toBe(70)
  })

  it("is unknown for a process whose count ends before the processes were read once", async () => {
    const at = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const watch = yield* cpuWatch(tableFor(), "1 minute")
        return watch.track(process.pid)()
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<number | undefined>
    )
    expect(at).toBeUndefined()
  })

  it("is nothing for a process the machine never showed", async () => {
    // No process has this number: the processes were read, and none of them was the one counted.
    const none = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const watch = yield* cpuWatch(tableFor(), "50 millis")
        const ended = watch.track(2 ** 30)
        yield* Effect.sleep("500 millis")
        return ended()
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<number | undefined>
    )
    expect(none).toBeUndefined()
  })

  it("reads nothing while it counts no process", async () => {
    let reads = 0
    const counting: Table = {
      ...tableFor(),
      read: Effect.sync(() => {
        reads += 1
        return []
      })
    }
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        yield* cpuWatch(counting, "20 millis")
        yield* Effect.sleep("200 millis")
      })).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<void>
    )
    expect(reads).toBe(0)
  })
})
