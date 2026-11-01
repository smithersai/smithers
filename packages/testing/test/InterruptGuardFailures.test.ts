/**
 * The interruption pin's defensive checks for malformed engine observations.
 *
 * A conformance subject is untrusted input to the suite. These doubles start
 * the real pin-supplied step, then violate one boundary at a time so the pin
 * must raise its stable `conformance_violation` with the failed observation
 * named, rather than throwing while inspecting it.
 */
import * as Effect from "effect/Effect"
import type { EngineSubject as Subject, ExecutionResult } from "../src/EngineSubject.vibe"
import * as EngineSubject from "../src/EngineSubject.vibe"
import * as Interrupt from "../src/pins/Interrupt.ts"
import { EngineUnavailableError } from "../src/TestingError.ts"
import { describe, expect, it } from "../src/Vitest.ts"

type Violation =
  | "runFailure"
  | "runMalformed"
  | "resultMalformed"
  | "journalMalformed"
  | "runFailedStatus"
  | "runSuspendedStatus"
  | "journalFailedOutcome"
  | "journalSuspendedOutcome"

const executionId = "testing/interrupt/in-flight/execution"
const stepKey = "interrupt/in-flight/step"
const aborted: ExecutionResult = { executionId, status: "aborted" }

const runResult = (violation: Violation): ExecutionResult =>
  violation === "runFailedStatus"
    ? { executionId, status: "failed" }
    : violation === "runSuspendedStatus"
    ? { executionId, status: "suspended" }
    : aborted

const journalOutcome = (violation: Violation): "aborted" | "failed" | "suspended" =>
  violation === "journalFailedOutcome"
    ? "failed"
    : violation === "journalSuspendedOutcome"
    ? "suspended"
    : "aborted"

const subject = (violation: Violation): Subject =>
  EngineSubject.make({
    name: `malformed-${violation}`,
    run: ((options) =>
      Effect.gen(function*() {
        const step = options.flow.steps[0]
        if (step?.kind === "step") {
          yield* step.run(options.payload).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
        }
        if (violation === "runFailure") {
          return yield* Effect.fail(new EngineUnavailableError({ message: "run escaped" }))
        }
        return violation === "runMalformed" ? null as never : runResult(violation)
      })) as Subject["run"],
    result: (() => Effect.succeed(violation === "resultMalformed" ? null as never : aborted)) as Subject["result"],
    interrupt: () => Effect.void,
    resume: () => Effect.succeed(aborted),
    journal: (() =>
      Effect.succeed(
        violation === "journalMalformed"
          ? [null as never]
          : [{ index: 0, stepKey, kind: "step", outcome: journalOutcome(violation) }]
      )) as Subject["journal"]
  })

describe("Interrupt pin malformed-subject guards", () => {
  it.effect("turns each malformed boundary into a typed conformance violation", () =>
    Effect.gen(function*() {
      const expectedMessages: ReadonlyArray<readonly [Violation, string]> = [
        ["runFailure", "escaped as a failure or defect"],
        ["runMalformed", "returned a malformed result"],
        ["resultMalformed", "stored a malformed result"],
        ["journalMalformed", "malformed journal transcript"],
        ["runFailedStatus", "settle as a well-formed aborted result"],
        ["runSuspendedStatus", "settle as a well-formed aborted result"],
        ["journalFailedOutcome", "record the interrupted step as an aborted outcome"],
        ["journalSuspendedOutcome", "record the interrupted step as an aborted outcome"]
      ]

      for (const [violation, message] of expectedMessages) {
        const error = yield* Interrupt.cases[0]!.run(subject(violation)).pipe(Effect.flip)
        expect(error).toMatchObject({
          code: "conformance_violation",
          pin: "interrupt/fiber-abort"
        })
        expect((error as { readonly message: string }).message).toContain(message)
      }
    }))
})
