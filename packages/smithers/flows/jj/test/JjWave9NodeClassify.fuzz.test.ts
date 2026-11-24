import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Layer, Logger, Schema, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import type * as EffectChildProcess from "effect/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import { isJjError, Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261175")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 120))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const enc = (text: string) => (text === "" ? Stream.empty : Stream.make(new TextEncoder().encode(text)))

describe("@smthrs/jj Wave 9 deep NodeJj.layerSpawner classification fuzzing", () => {
  it("NodeJj.layerSpawner classifies every jj stderr/stdout/exit/version/spawn failure mode cleanly", async () => {
    const scenarios = [
      "ok-status",
      "ok-refused-warning",
      "version-too-old",
      "version-garbage",
      "spawn-not-found",
      "spawn-permission-denied",
      "conflict",
      "chained-conflict",
      "revision-not-found",
      "path-doesnt-exist",
      "revision-doesnt-exist",
      "revset-parse",
      "revset-fewer",
      "revset-more",
      "stdout-only-error",
      "silent-exit",
      "stale-wc",
      "lock-contention"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals(scenarios),
        op: Schema.Literals(["status", "diff", "opId", "root"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, op }) =>
          Effect.gen(function*() {
            const spawnerLayer = Layer.succeed(ChildProcessSpawner)(
              makeSpawner((command: EffectChildProcess.Command) => {
                const std = command as EffectChildProcess.StandardCommand
                const args = std.args.map(String)
                if (scenario === "spawn-not-found") {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "jj not found"
                    })
                  )
                }
                if (scenario === "spawn-permission-denied") {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "ChildProcess",
                      method: "spawn",
                      description: "jj not executable"
                    })
                  )
                }
                if (args.includes("--version")) {
                  const verText = scenario === "version-too-old"
                    ? "jj 0.25.0\n"
                    : scenario === "version-garbage"
                    ? "not-a-jj-version\n"
                    : "jj 0.39.0\n"
                  return Effect.succeed(
                    makeHandle({
                      pid: ProcessId(1),
                      exitCode: Effect.succeed(ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: enc(verText),
                      stderr: Stream.empty,
                      all: enc(verText),
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void)
                    })
                  )
                }

                let stdout = ""
                let stderr = ""
                let code = 0
                switch (scenario) {
                  case "ok-status":
                    stdout = args.includes("op")
                      ? "0123456789abcdef\n"
                      : op === "diff"
                      ? ""
                      : op === "root"
                      ? "/tmp/repo\n"
                      : "The working copy is clean\n"
                    break
                  case "ok-refused-warning":
                    stdout = op === "opId" ? "0123456789abcdef\n" : "ok\n"
                    stderr = "Warning: Refused to snapshot some files:\n  big.bin: 2.0MiB\n"
                    break
                  case "conflict":
                    stderr = "Error: would leave conflicts in note.txt\n"
                    code = 1
                    break
                  case "chained-conflict":
                    stderr = "Error: Failed to update the working copy\nCaused by: The merge would leave conflicts\n"
                    code = 1
                    break
                  case "revision-not-found":
                    stderr = "Error: Revision not found\n"
                    code = 1
                    break
                  case "path-doesnt-exist":
                    stderr = "Error: Path doesn't exist: missing.txt\n"
                    code = 1
                    break
                  case "revision-doesnt-exist":
                    stderr = "Error: Revision \"conflict-fix\" doesn't exist\n"
                    code = 1
                    break
                  case "revset-parse":
                    stderr = "Error: Failed to parse revset: Syntax error\n"
                    code = 1
                    break
                  case "revset-fewer":
                    stderr = "Error: The revset has fewer than the expected 1 revisions (got 0)\n"
                    code = 1
                    break
                  case "revset-more":
                    stderr = "Error: The revset has more than the expected 1 revisions\n"
                    code = 1
                    break
                  case "stdout-only-error":
                    stdout = "Error: reported on stdout\n"
                    code = 1
                    break
                  case "silent-exit":
                    code = 3
                    break
                  case "stale-wc":
                    stderr = "Error: The working copy is stale (not updated since operation abc123)\n"
                    code = 1
                    break
                  case "lock-contention":
                    stderr = "Error: Unable to create '.git/index.lock': File exists.\n"
                    code = 1
                    break
                }

                return Effect.succeed(
                  makeHandle({
                    pid: ProcessId(2),
                    exitCode: Effect.succeed(ExitCode(code)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    stdin: Sink.drain,
                    stdout: enc(stdout),
                    stderr: enc(stderr),
                    all: enc(stdout + stderr),
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void)
                  })
                )
              })
            )

            const jjLayer = budgeted(NodeJj.layerSpawnerAt("/tmp")).pipe(
              Layer.provide(spawnerLayer)
            )

            const runOp = Effect.gen(function*() {
              const jj = yield* Jj
              if (op === "status") return yield* jj.status()
              if (op === "diff") return yield* jj.diff("@-", "@")
              if (op === "opId") return yield* jj.restore("@")
              if (op === "root") return yield* (jj.root ? jj.root("/tmp") : jj.status())
              return yield* jj.status()
            }).pipe(Effect.provide(jjLayer))

            const exit = yield* Effect.exit(runOp)
            if (scenario === "ok-status") {
              expect(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "").toBe(true)
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                const err = exit.cause.reasons.find(Cause.isFailReason)?.error
                expect(isJjError(err), String(exit.cause)).toBe(true)
              }
            }
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)
})
