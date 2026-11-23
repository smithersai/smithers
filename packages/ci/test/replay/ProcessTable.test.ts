/** Reading the machine's processes: the formats, and the real tables of this machine. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { fromPs, fromStat, treeOf, workOver } from "../../src/replay/ProcessTable.ts"
import { tableFor } from "../../src/replay/Stall.vibe"

const denied = (method: string) => PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method })

const onNode = <A, E, R>(work: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(work, NodeServices.layer) as Effect.Effect<A, E>)

describe("the formats", () => {
  it("reads a line of /proc, with a name that holds spaces and parentheses", () => {
    const fields = "S 7 1 1 0 -1 0 0 0 0 0 3 2 4 1 20 0 1 0 5 6 7"
    // The process itself used 3 + 2 ticks, the children it waited for 4 + 1, and it started at tick 5.
    expect(fromStat(`42 (a (b) c) ${fields}`)).toEqual({
      pid: 42,
      parent: 7,
      cpuMs: 100,
      ownMs: 50,
      waitedMs: 50,
      started: 5
    })
  })

  it("refuses what is not such a line", () => {
    expect(fromStat("")).toBeUndefined()
    expect(fromStat("42 (short) S 7")).toBeUndefined()
    expect(fromStat("x (name) S y 1 1 0 -1 0 0 0 0 0 3 2 4 1")).toBeUndefined()
  })

  it("reads each form of the time ps prints, and skips other lines", () => {
    expect(
      fromPs(
        ["  1 0 00:05", "2  1  01:02.50", "3 1 1:00:00", "4 1 2-00:00:01", "5 1 not-a-time", "garbage", ""].join("\n")
      )
    )
      .toEqual([
        { pid: 1, parent: 0, cpuMs: 5000 },
        { pid: 2, parent: 1, cpuMs: 62_500 },
        { pid: 3, parent: 1, cpuMs: 3_600_000 },
        { pid: 4, parent: 1, cpuMs: 172_801_000 }
      ])
  })

  it("adds up a tree and finds what it waits in", () => {
    const entries = [
      { pid: 1, parent: 0, cpuMs: 1 },
      { pid: 2, parent: 1, cpuMs: 2 },
      { pid: 3, parent: 2, cpuMs: 4 },
      { pid: 4, parent: 1, cpuMs: 8 },
      { pid: 9, parent: 0, cpuMs: 100 }
    ]
    const tree = treeOf(entries, 1)
    expect(tree.cpuMs).toBe(15)
    expect([...tree.pids].sort()).toEqual([1, 2, 3, 4])
    expect([...tree.leaves].sort()).toEqual([3, 4])
    expect(treeOf(entries, 77)).toEqual({ cpuMs: 0, pids: [], leaves: [] })
  })

  it("survives a table where a process is its own parent", () => {
    expect(treeOf([{ pid: 1, parent: 1, cpuMs: 3 }], 1)).toEqual({ cpuMs: 3, pids: [1], leaves: [1] })
  })

  it("asks for one hundredth of a core, and at least one tick", () => {
    expect(workOver(100)).toBe(10)
    expect(workOver(60_000)).toBe(600)
  })
})

describe.each(["linux", "darwin"])("the table read the way %s reads it", (host) => {
  it("finds a running process under its parent, and stops it", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" })
    const ended = new Promise((resolve) => child.once("exit", resolve))
    const table = tableFor(host)
    const entries = await onNode(table.read)
    expect(entries?.find((entry) => entry.pid === child.pid)?.parent).toBe(process.pid)
    await onNode(table.stop([child.pid as number], process.pid))
    await ended
    expect(child.signalCode).toBe("SIGKILL")
  })

  it("skips the root and a missing process at the final ancestry check", async () => {
    const commands: Array<string> = []
    const recorder = Layer.succeed(
      ChildProcessSpawner,
      makeSpawner((command) => {
        if (command._tag === "StandardCommand") commands.push(command.command)
        return Effect.fail(denied("spawn"))
      })
    )
    await onNode(tableFor(host).stop([process.pid, 2_147_483_647], process.pid).pipe(Effect.provide(recorder)))
    expect(commands).toEqual(host === "linux" ? [] : ["ps"])
  })

  it("does nothing when asked to stop nothing", async () => {
    await onNode(tableFor(host).stop([], process.pid))
  })
})

describe("the table of Linux where no program reads it in one go", () => {
  const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied("spawn"))))
  /** Every program started prints nothing and passes. */
  const silent = Layer.effect(
    ChildProcessSpawner,
    Effect.gen(function*() {
      const real = yield* ChildProcessSpawner
      return makeSpawner(() => real.spawn(ChildProcess.make("true", [])))
    })
  )

  it.each([["cannot be started", noPrograms], ["prints nothing", silent]])(
    "is read file by file when the program %s",
    async (_what, programs) => {
      const child = spawn("sleep", ["60"], { stdio: "ignore" })
      const entries = await onNode(tableFor("linux").read.pipe(Effect.provide(programs)))
      child.kill("SIGKILL")
      expect(entries?.find((entry) => entry.pid === child.pid)?.parent).toBe(process.pid)
    }
  )
})

/** Whether this machine's kernel lists the processes each thread started. */
const listsChildren = existsSync(`/proc/${process.pid}/task/${process.pid}/children`)

describe("the processes under one process", () => {
  it.skipIf(!listsChildren)(
    "are read by walking down from it, and no other process of the machine with them",
    async () => {
      // A shell that starts a process and waits for it: two processes, one under the other.
      const child = spawn("sh", ["-c", "sleep 60 & wait"], { stdio: "ignore" })
      const under = tableFor("linux").under as NonNullable<ReturnType<typeof tableFor>["under"]>
      let entries = await onNode(under(child.pid as number))
      // The shell may be read before it has started its process.
      for (let tries = 0; tries < 50 && entries?.length !== 2; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        entries = await onNode(under(child.pid as number))
      }
      expect(entries?.map((entry) => entry.parent)).toEqual([process.pid, child.pid])
      expect(entries?.[0]?.pid).toBe(child.pid)
      const started = entries?.[1]?.pid as number
      const ended = new Promise((resolve) => child.once("exit", resolve))
      process.kill(started, "SIGKILL")
      await ended
      // A process that is gone has nothing under it, and that is an answer.
      expect(await onNode(under(child.pid as number))).toEqual([])
    }
  )

  it("cannot be read alone where no shell can be started, and no system but Linux has a reader for them", async () => {
    const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied("spawn"))))
    const under = tableFor("linux").under as NonNullable<ReturnType<typeof tableFor>["under"]>
    expect(await onNode(under(process.pid).pipe(Effect.provide(noPrograms)))).toBeUndefined()
    expect(tableFor("darwin").under).toBeUndefined()
  })
})

describe("a table that cannot be read", () => {
  const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied("spawn"))))

  it("is no table on Linux when /proc cannot be listed, by a program or file by file", async () => {
    const noProc = FileSystem.layerNoop({ readDirectory: () => Effect.fail(denied("readDirectory")) })
    const unreadable = Layer.merge(noProc, noPrograms)
    expect(await onNode(tableFor("linux").read.pipe(Effect.provide(unreadable)))).toBeUndefined()
  })

  it("leaves out a process that ends while it is read", async () => {
    const vanishing = FileSystem.layerNoop({
      readDirectory: () => Effect.succeed(["1", "self"]),
      readFileString: () => Effect.fail(denied("readFileString"))
    })
    const byFile = Layer.merge(vanishing, noPrograms)
    expect(await onNode(tableFor("linux").read.pipe(Effect.provide(byFile)))).toEqual([])
  })

  it("is no table when ps fails", async () => {
    const failing = Layer.effect(
      ChildProcessSpawner,
      Effect.gen(function*() {
        const real = yield* ChildProcessSpawner
        return makeSpawner(() => real.spawn(ChildProcess.make("sh", ["-c", "exit 1"])))
      })
    )
    expect(await onNode(tableFor("darwin").read.pipe(Effect.provide(failing)))).toBeUndefined()
  })

  it("is no table when ps cannot be started", async () => {
    const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied("spawn"))))
    expect(await onNode(tableFor("darwin").read.pipe(Effect.provide(noPrograms)))).toBeUndefined()
  })
})
