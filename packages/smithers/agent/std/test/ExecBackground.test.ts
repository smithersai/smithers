/**
 * A command's answer is ready when the command exits.
 *
 * `server &` exits at once and leaves a process holding both pipes, and an
 * execution that waited for end of stream reported the shell's exit 0 as a
 * timeout ten minutes later. These cases run a real shell through the real
 * spawner, because whether a pipe stays open is the operating system's fact.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Layer, Sink, Stream } from "effect"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as Exec from "../src/internal/Exec.ts"

const host = Layer.provide(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

describe.skipIf(process.platform === "win32")("Exec with a process left in the background", () => {
  it.live("returns the exit code and the output when a silent background child holds the pipes", () =>
    Effect.gen(function*() {
      const started = Date.now()
      const result = yield* Exec.exec("sleep 5 & echo started", { timeoutMs: 4_000 })
      expect(result).toMatchObject({ exitCode: 0, stdout: "started\n", stderr: "" })
      expect(Date.now() - started).toBeLessThan(2_000)
    }).pipe(Effect.provide(host)))

  it.live("stops waiting on a background child that keeps printing", () =>
    Effect.gen(function*() {
      const started = Date.now()
      // Ten seconds of output every 20 ms: no quiet window ever passes, so
      // only the bound on windows ends the capture.
      const chatty = "(i=0; while [ $i -lt 500 ]; do echo tick; sleep 0.02; i=$((i+1)); done) & echo started"
      const result = yield* Exec.exec(chatty, { timeoutMs: 8_000 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.startsWith("started\n") || result.stdout.includes("started\n")).toBe(true)
      expect(result.stdout).toContain("tick\n")
      expect(Date.now() - started).toBeLessThan(5_000)
    }).pipe(Effect.provide(host)))

  it.live("still returns everything a command printed before it exited", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec("head -c 300000 /dev/zero | tr '\\0' x; echo; echo done >&2")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toHaveLength(300_001)
      expect(result.stderr).toBe("done\n")
    }).pipe(Effect.provide(host)))
})

describe("Exec with a failing output stream", () => {
  it.effect("fails the call at once when a stream fails before the command exits", () =>
    Effect.gen(function*() {
      const broken = Stream.fail(PlatformError.badArgument({
        module: "ChildProcess",
        method: "stdout",
        description: "pipe broke"
      }))
      const spawner = ChildProcessSpawner.makeNoop({
        spawn: () =>
          Effect.succeed(makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.never.pipe(Effect.as(ExitCode(0))),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: broken,
            stderr: Stream.empty,
            all: broken,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          }))
      })
      const error = yield* Exec.exec("anything").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.flip
      )
      expect(error).toMatchObject({ code: "spawn_error" })
      expect(error.message).toContain("pipe broke")
    }))
})
