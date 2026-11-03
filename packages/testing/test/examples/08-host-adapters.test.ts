import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../../examples/08-host-adapters.vibe"

it.effect("runs one host program on the test and Node adapters", () =>
  Effect.gen(function*() {
    const summary = yield* main
    expect(summary.scriptedRead).toBe("hello from memory")
    expect(summary.scriptedExec).toBe("hello from script")
    // The Node adapter ran the same program, so it read a file too. Asserting
    // only the command would pass for a Node-only effect that skips the read.
    expect(summary.nodeRead).toBe("hello from disk")
    expect(summary.nodeExec).toBe("hello from node")
  }))
