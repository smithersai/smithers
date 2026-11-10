/** Broken native process pipes fail through the fixture's Effect boundary. */
import { expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as ProcessContainer from "./fixtures/ProcessContainer.ts"

it.live("a process that closes stdin reports the failed write without an uncaught stream error", () =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* ProcessContainer.make().container.exec(
      ["sh", "-c", "exec 0<&-; printf ready; sleep 0.2"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    )
    // Wait for a real acknowledgement that the child closed its input before writing.
    yield* Stream.runHead(process.stdout!)
    const written = yield* Effect.result(Stream.run(Stream.make(new Uint8Array(1024 * 1024)), process.stdin!))
    expect(written).toMatchObject({ _tag: "Failure", failure: { _tag: "ProcessFailure" } })
    expect(yield* process.exitCode).toBe(0)
  })))
