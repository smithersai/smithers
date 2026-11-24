/**
 * Every host command the library starts on its own account has a deadline.
 *
 * Host git, `rg`, and a remote search's shell ran with no time limit, so a
 * stalled mount hung the tool call that asked. A containerised test run and a
 * containerised git script had a limit only on the host's transport process,
 * which stops nothing inside the container. The first three are driven with a
 * process that never exits under the test clock; the container cases run real
 * processes, because what survives a deadline is the operating system's fact.
 */
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Path, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { TestClock } from "effect/testing"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.ts"
import { GitWorktree } from "../src/internal/GitWorktree.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as RemoteSearch from "../src/RemoteSearch.ts"
import * as Search from "../src/Search.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "flows-deadlines-")))
// A native search starts no `rg` for a root with no file in it.
writeFileSync(join(scratch, "a.txt"), "needle\n")
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as
      | { code?: string; message?: string; limitMillis?: number; output?: { stdout: string; stderr: string } }
      | undefined
    : undefined

/**
 * Runs `effect` against a process that starts and never exits, moves the test
 * clock `millis` once it has started, and answers how the call ended.
 */
const stalledFor = <A, E>(
  millis: number,
  effect: (
    spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
  ) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const stalled = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
        ChildProcessSpawner.makeNoop({
          spawn: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        })
      )
      const fiber = yield* Effect.forkChild(effect(stalled))
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* TestClock.adjust(millis)
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(TestClock.layer()))
  )

describe("host commands that never exit", () => {
  it("fails host git with timeout after ten minutes", async () => {
    const exit = await stalledFor(
      600_000,
      (stalled) => GitWorktree.resolveCommit("/repo", ["HEAD"]).pipe(Effect.provide(stalled))
    )
    expect(failureOf(exit)).toMatchObject({ code: "timeout" })
    expect(failureOf(exit)?.message).toContain("git could not run")
  })

  it("fails a native search with timeout after ten minutes", async () => {
    const exit = await stalledFor(NativeSearch.TIMEOUT_MS, (stalled) =>
      Effect.gen(function*() {
        const search = yield* Search.Search
        return yield* search.glob({ root: scratch, pattern: "*", hidden: false, limit: 10 })
      }).pipe(
        Effect.provide(
          NativeSearch.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, stalled)))
        )
      ))
    expect(NativeSearch.TIMEOUT_MS).toBe(600_000)
    expect(failureOf(exit)).toMatchObject({ code: "timeout", limitMillis: 600_000, path: scratch })
  })

  it("fails a remote search with timeout after ten minutes", async () => {
    const exit = await stalledFor(RemoteSearch.TIMEOUT_MS, (stalled) =>
      Effect.gen(function*() {
        const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>()
        return yield* RemoteSearch.make(services).glob({
          root: scratch,
          pattern: "*",
          hidden: false,
          limit: 10
        })
      }).pipe(Effect.provide(Layer.merge(NodePath.layer, stalled))))
    expect(RemoteSearch.TIMEOUT_MS).toBe(600_000)
    expect(failureOf(exit)).toMatchObject({ code: "timeout", limitMillis: 600_000, path: scratch })
  })
})

/** A container named `task` that is this host: the request runs here, in `workdir`. */
const inDirectory = [
  "const { spawnSync } = require(\"node:child_process\")",
  "const [cwd, file, ...args] = process.argv.slice(1)",
  "const result = spawnSync(file, args, { cwd, stdio: \"inherit\" })",
  "if (result.error) throw result.error",
  "process.exit(result.status ?? 1)"
].join("\n")

const task = (workdir: string, rewrite: (request: Container.Request) => Container.Request = (request) => request) =>
  Container.make({
    exec: (incoming) => {
      const request = rewrite(incoming)
      return Effect.succeed({
        file: process.execPath,
        args: ["--eval", inDirectory, request.cwd ?? workdir, request.file, ...request.args],
        env: request.env
      })
    }
  })

const judge = Evaluator.layerScripted(() => ({ attribution: { choice: "tree" }, executed: { probability: 0.95 } }))

describe.skipIf(process.platform === "win32")("deadlines enforced where a containerised command runs", () => {
  it("stops a containerised test run at its time limit and leaves nothing running", async () => {
    const workdir = mkdtempSync(join(scratch, "suite-"))
    const pidFile = join(workdir, "runner.pid")
    const exit = await Effect.runPromiseExit(
      TestRun.run({ timeoutMs: 1_000 }).pipe(
        Effect.provide(Layer.mergeAll(
          NodeServices.layer,
          judge,
          TestRunner.layer({
            command: `echo collected; echo $$ > ${pidFile}; exec sleep 600`,
            cwd: workdir,
            container: "task"
          }),
          Layer.succeed(Container.Container)(task(workdir))
        ))
      )
    )
    const failure = failureOf(exit)
    expect(failure).toMatchObject({ code: "timeout", limitMillis: 1_000 })
    expect(failure?.output?.stdout).toBe("collected\n")
    // The wrapper's own report is not the runner's output.
    expect(failure?.output?.stderr).not.toContain(TreeFingerprint.marker)
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 30_000)

  it("reads a containerised run's output without the wrapper's report", async () => {
    const workdir = mkdtempSync(join(scratch, "suite-"))
    const output = await Effect.runPromise(
      TestRun.run({}).pipe(
        Effect.provide(Layer.mergeAll(
          NodeServices.layer,
          judge,
          TestRunner.layer({ command: "echo '2 passed in 0.1s'; echo warned >&2", cwd: workdir, container: "task" }),
          Layer.succeed(Container.Container)(task(workdir))
        ))
      )
    )
    expect(output).toMatchObject({ exitCode: 0, passed: 2 })
    expect(output.tail).toBe("2 passed in 0.1s\n\nwarned\n")
  }, 30_000)

  it("reports the deadline a transport's report names, with what the runner printed", async () => {
    // The transport returned normally: the wrapper stopped the runner and
    // said so in the line framed with this call's nonce.
    const reporting = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.sync(() => {
          const args = (command as ChildProcess.StandardCommand).args as ReadonlyArray<string>
          const nonce = args[args.indexOf(TreeFingerprint.around()) + 2]!
          const text = (value: string) => Stream.make(new TextEncoder().encode(value))
          return makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.succeed(ExitCode(143)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: text("collected 3 items\n"),
            stderr: text(`hung in test_c\n\n${TreeFingerprint.marker} ${nonce} deadline | \n`),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        })
    }))
    const exit = await Effect.runPromiseExit(
      TestRun.run({ timeoutMs: 2_500 }).pipe(
        Effect.provide(Layer.mergeAll(
          reporting,
          judge,
          TestRunner.layer({ command: "pytest", cwd: "/testbed", container: "task" }),
          Layer.succeed(Container.Container)(Container.makeCommand())
        ))
      )
    )
    expect(failureOf(exit)).toMatchObject({
      code: "timeout",
      limitMillis: 2_500,
      message: "The test runner did not run: exec: `bash -c pytest \"$@\" pytest` exceeded 2500ms",
      output: { stdout: "collected 3 items\n", stderr: "hung in test_c\n" }
    })
  })

  it("stops a containerised git script at its time limit, inside the container", async () => {
    const app = mkdtempSync(join(scratch, "app-"))
    execFileSync("git", ["-C", app, "init", "--quiet"])
    const pidFile = join(app, "git.pid")
    // Every git script hangs before it does anything, as a stalled mount would.
    const hung = task(app, (request) => ({
      ...request,
      args: request.args.map((arg, index) => index === 4 ? `echo $$ > ${pidFile}; exec sleep 600\n${arg}` : arg)
    }))
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(
        Checkpoints.makeContainer({ container: "task", gitTimeoutMs: 1_000 }),
        (store) => store.capture("cp-1-1")
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(Container.Container)(hung))))
    )
    expect(failureOf(exit)).toMatchObject({
      code: "timeout",
      limitMillis: 1_000,
      message: "git in container task timed out"
    })
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 30_000)

  it("runs a container's git script to its end when it finishes inside the limit", async () => {
    const app = mkdtempSync(join(scratch, "app-"))
    execFileSync("git", ["-C", app, "init", "--quiet"])
    writeFileSync(join(app, "a.txt"), "a\n")
    execFileSync("git", ["-C", app, "add", "."])
    execFileSync("git", [
      "-C",
      app,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "commit",
      "--quiet",
      "-m",
      "one"
    ])
    const snapshot = await Effect.runPromise(
      Effect.flatMap(Checkpoints.makeContainer({ container: "task" }), (store) => store.capture("cp-1-1")).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(Container.Container)(task(app))))
      )
    )
    expect(snapshot.ref).toBe(execFileSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
  }, 30_000)
})
