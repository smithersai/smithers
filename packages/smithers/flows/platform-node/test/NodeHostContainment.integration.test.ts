/**
 * The contained Node host, booted the way a program boots it.
 *
 * `NodeHost.layerContained` is the whole of A31 seen from outside: one layer
 * that hands out the same five host services `NodeHost.layer` does, spawns
 * through the contained spawner, and reaps what a dead incarnation left behind
 * on the way up. These cases drive it over real processes and a real ledger.
 */
import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import { ProcessLedger } from "@smthrs/kernel"
import { Effect, Fiber, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, beforeAll } from "vitest"
import * as ProcessTable from "../../../../testing/src/ProcessTable.ts"
import * as NodeHost from "../src/NodeHost.ts"

// Windows needs a real executable; the SEA runs each adjacent fixture in
// the invocation's process, preserving cancellation and descendant ownership.
let launcherDirectory: string | undefined
let launcher: string | undefined
beforeAll(() => {
  if (process.platform !== "win32") return
  launcherDirectory = mkdtempSync(join(tmpdir(), "flows-jj-launcher-"))
  const main = join(launcherDirectory, "main.cjs")
  const config = join(launcherDirectory, "sea.json")
  launcher = join(launcherDirectory, "jj.exe")
  writeFileSync(main, "const file=process.execPath+'.cjs';require('node:module').createRequire(file)(file)")
  writeFileSync(
    config,
    JSON.stringify({ main, output: launcher, disableExperimentalSEAWarning: true, execArgvExtension: "none" })
  )
  execFileSync(process.execPath, ["--build-sea", config], { timeout: 60_000 })
}, 60_000)
afterAll(() => {
  if (launcherDirectory !== undefined) rmSync(launcherDirectory, { recursive: true, force: true })
})
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const writeJj = (directory: string, body: string): string => {
  const executable = join(directory, process.platform === "win32" ? "jj.exe" : "jj")
  const script = `${executable}.cjs`
  writeFileSync(script, `if(process.argv.includes('--version')){process.stdout.write('jj 0.39.0\\n')}else{${body}}`)
  if (launcher !== undefined) copyFileSync(launcher, executable)
  else {
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`)
    chmodSync(executable, 0o755)
  }
  return executable
}
const groupOf = (pid: number) => process.platform === "win32" ? null : pid

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const waitForExit = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await sleep(10)
  }
}

/** Every process on this machine whose command line names `path`. */
const survivors = (path: string): ReadonlyArray<string> =>
  ProcessTable.query({ columns: ["pid", "ppid", "args"] })
    .split("\n")
    .filter((line) => line.includes(path))

/** Waits until nothing names `path` any more, or gives up after `budgetMs`. */
const waitForNoSurvivor = async (path: string, budgetMs: number): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const found = survivors(path)
    if (found.length === 0) return found
    if (Date.now() > deadline) return found
    await sleep(20)
  }
}

/** Waits for a shim to report through a file that it is running. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return text
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error(`the shim never wrote ${path}`)
}

describe("NodeHost.layerContained", () => {
  it.live("binds ordinary jj operations to the requested repository root", () =>
    Effect.gen(function*() {
      const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "flows-node-host-bound-jj-")))
      writeJj(directory, "process.stdout.write(process.cwd())")
      const previousPath = process.env["PATH"]
      process.env["PATH"] = `${directory}${delimiter}${previousPath ?? ""}`

      try {
        const status = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(
          Effect.provide(NodeHost.layerAt(directory)),
          Effect.scoped
        )

        expect(status.trim()).toBe(realpathSync.native(directory))
      } finally {
        process.env["PATH"] = previousPath
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.live("records what it spawns and kills the group when the scope closes", () =>
    Effect.gen(function*() {
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "node-host", ownerPid: process.pid })
      const host = NodeHost.layerContained({ graceMs: 300 }).pipe(
        Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
      )

      const observed = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        // Every other host service still comes out of the same layer.
        yield* FileSystem.FileSystem
        const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", "setInterval(()=>{},1000)"]))
        return { pid: handle.pid as number, live: yield* ledger.live }
      }).pipe(Effect.provide(host), Effect.scoped)

      expect(observed.live).toEqual([
        expect.objectContaining({ pid: observed.pid, pgid: groupOf(observed.pid), commandDigest: process.execPath })
      ])
      // The scope closed with the fiber, so the process is gone and the
      // ledger no longer claims it.
      expect(yield* Effect.promise(() => waitForExit(observed.pid, 2_000))).toBe(true)
      expect(yield* ledger.live).toEqual([])
    }))

  /**
   * `ContainedSpawner.Options.platform` decides only whether a child gets a
   * process group of its own, and Effect's Node spawner decides that from the
   * REAL `process.platform` whatever the ledger was told. A caller-supplied
   * `"win32"` therefore used to win the spread and record `pgid: null` for a
   * child that genuinely leads a group: the reaper then refuses that record as
   * `no-group` and the orphan outlives every incarnation. The option is gone
   * from the type, and this pins that a cast cannot put it back.
   */
  it.live("records the real process group even when a caller claims another platform", () =>
    Effect.gen(function*() {
      const spoofed = {
        graceMs: 300,
        platform: process.platform === "win32" ? "linux" : "win32"
      } as NodeHost.ContainedOptions
      for (
        const build of [
          () => NodeHost.layerContained(spoofed),
          () => NodeHost.layerContainedAt(realpathSync(tmpdir()), spoofed)
        ]
      ) {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "spoofed", ownerPid: process.pid })
        const host = build().pipe(Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger)))
        const observed = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", "setInterval(()=>{},1000)"]))
          return { pid: handle.pid as number, live: yield* ledger.live }
        }).pipe(Effect.provide(host), Effect.scoped)

        expect(observed.live).toEqual([
          expect.objectContaining({ pid: observed.pid, pgid: groupOf(observed.pid) })
        ])
        expect(yield* Effect.promise(() => waitForExit(observed.pid, 2_000))).toBe(true)
      }
    }), 30_000)

  it.live("records the children `jj` starts, instead of letting them out the side", () =>
    Effect.gen(function*() {
      // `NodeJj.layer` spawns through `node:child_process` directly, so a jj
      // child leads no group the host recorded and no reaper can ever find it.
      // Under containment the host builds jj over its OWN spawner, and this is
      // the observable difference: the invocation shows up in the ledger like
      // any other child.
      const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "flows-contained-jj-")))
      const executable = writeJj(directory, "process.stdout.write(process.cwd())")
      const previousPath = process.env["PATH"]
      process.env["PATH"] = directory

      try {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "contained-jj", ownerPid: process.pid })
        const recorded: Array<string> = []
        const host = NodeHost.layerContainedAt(directory, { graceMs: 300 }).pipe(
          Layer.provide(
            Layer.succeed(ProcessLedger.ProcessLedger)({
              ...ledger,
              record: (spawned) =>
                Effect.tap(ledger.record(spawned), (row) => Effect.sync(() => recorded.push(row.commandDigest)))
            })
          )
        )

        const status = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(Effect.provide(host), Effect.scoped)

        expect(status.trim()).toBe(realpathSync.native(directory))
        // Both the startup version probe and status use the pinned binary and
        // contained spawner; neither may escape the ledger.
        expect(recorded).toEqual([executable, executable])
        // The invocation finished, so the record was retired with it.
        expect(yield* ledger.live).toEqual([])
      } finally {
        process.env["PATH"] = previousPath
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.live("kills the group a cancelled `jj` leads, grandchildren included", () =>
    Effect.gen(function*() {
      // The reason `layerContained` builds jj over its own spawner rather than
      // letting `NodeJj.layer` start its own children: a jj that ignores
      // `SIGTERM`, or that left something running behind it, is contained by
      // the host's policy like any other child instead of being a process
      // nothing on the machine can account for.
      const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "flows-contained-jj-cancel-")))
      const marker = join(directory, "flows-jj-cancel-shim")
      const pidFile = join(directory, "background.pid")
      writeFileSync(marker, "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)")
      writeJj(
        directory,
        `
        process.on('SIGTERM',()=>{});
        const child=require('node:child_process').spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(marker)}],
          {stdio:['ignore','ignore','ignore','ipc']});
        child.once('message',()=>require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)));
        setInterval(()=>{},1000);`
      )
      const previousPath = process.env["PATH"]
      // Prepended, not replaced: the survivor scan runs `ps`.
      process.env["PATH"] = `${directory}${delimiter}${previousPath ?? ""}`

      try {
        const graceMs = 400
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "cancelled-jj", ownerPid: process.pid })
        const host = NodeHost.layerContained({ graceMs }).pipe(
          Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
        )
        const fiber = yield* Effect.forkChild(
          Effect.exit(Effect.flatMap(Jj, (jj) => jj.status())).pipe(Effect.provide(host), Effect.scoped),
          { startImmediately: true }
        )

        yield* Effect.promise(() => waitForFile(pidFile))
        expect(survivors(marker).length).toBeGreaterThan(0)

        const before = Date.now()
        yield* Fiber.interrupt(fiber)

        // The background process is the one nothing held a handle for, and
        // `trap "" TERM` means only the escalation could have ended it.
        expect(yield* Effect.promise(() => waitForNoSurvivor(marker, graceMs + 1_000))).toEqual([])
        // Windows terminates SIGTERM targets unconditionally. POSIX must
        // preserve the requested grace before escalating stubborn children.
        if (process.platform !== "win32") expect(Date.now() - before).toBeGreaterThanOrEqual(graceMs)
        expect(yield* ledger.live).toEqual([])
      } finally {
        process.env["PATH"] = previousPath
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)
})
