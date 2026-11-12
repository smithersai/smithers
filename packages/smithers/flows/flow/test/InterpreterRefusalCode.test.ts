/**
 * A run the interpreter refused says why, wherever its result is read.
 *
 * `Flow.Result` keeps an `InterpreterError` defect whole through its JSON
 * codec, which is how a durable store writes a settled run and how a browser
 * engine's leader replies to a tab, so `Interpreter.refusalCode` reads the
 * same code from a live exit, a stored one, and one relayed again. A result
 * stored before the code was kept still reads `plan_changed`.
 */
import { Flow, Interpreter } from "@smthrs/flow"
import { Cause, Exit, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

const codec = Schema.toCodecJson(Flow.Result({ success: Schema.Number, error: Schema.String }))

/** A result written by the codec and read back, as a store or a relay does. */
const stored = (result: Flow.Result<number, string>): Flow.Result<number, string> =>
  Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(result))))

const causeOf = (result: Flow.Result<number, string>): Cause.Cause<unknown> => {
  if (result._tag !== "Complete" || Exit.isSuccess(result.exit)) throw new Error("expected a failed completion")
  return result.exit.cause
}

const refused = new Interpreter.InterpreterError({
  code: "plan_changed",
  flow: "refusal-code/answer",
  node: "root",
  message: "The rebuilt plan differs from the recorded plan; start a new execution"
})

describe("Interpreter.refusalCode", () => {
  it("reads the code of a live refusal, failed or died", () => {
    expect(Interpreter.refusalCode(Cause.die(refused))).toEqual(Option.some("plan_changed"))
    expect(Interpreter.refusalCode(Cause.fail(refused))).toEqual(Option.some("plan_changed"))
  })

  it.each(["plan_changed", "payload_changed", "uncanonical_payload"] as const)(
    "reads %s from a refusal written and read back, twice",
    (code) => {
      const once = stored(
        new Flow.Complete({
          exit: Exit.die(
            new Interpreter.InterpreterError({ code, flow: refused.flow, node: refused.node, message: refused.message })
          )
        })
      )
      const twice = stored(once)
      for (const result of [once, twice]) {
        const defect = Cause.squash(causeOf(result))
        expect(defect).toBeInstanceOf(Interpreter.InterpreterError)
        expect(defect).toMatchObject({ code, flow: "refusal-code/answer", node: "root" })
        expect(Interpreter.refusalCode(causeOf(result))).toEqual(Option.some(code))
      }
    }
  )

  it("reads plan_changed from a result stored before the code was kept", () => {
    // What a store held: the defect codec kept only the error's name and message.
    const legacy = (message: string) =>
      Schema.decodeUnknownSync(codec)({
        _tag: "Complete",
        exit: {
          _tag: "Failure",
          cause: [{ _tag: "Die", defect: { name: "@smthrs/flow/InterpreterError", message } }]
        }
      })
    expect(Interpreter.refusalCode(causeOf(legacy(refused.message)))).toEqual(Option.some("plan_changed"))
    // Any other stored refusal had no recoverable code.
    expect(Interpreter.refusalCode(causeOf(legacy("Action x has no implementation")))).toEqual(Option.none())
  })

  it("answers nothing for a failure that is not a refusal", () => {
    expect(Interpreter.refusalCode(Cause.die(new Error("boom")))).toEqual(Option.none())
    expect(Interpreter.refusalCode(Cause.fail("declared"))).toEqual(Option.none())
    expect(Interpreter.refusalCode(Cause.interrupt())).toEqual(Option.none())
    expect(Interpreter.refusalCode(Cause.empty)).toEqual(Option.none())
    const other = stored(new Flow.Complete({ exit: Exit.die(new Error("boom")) }))
    expect(Cause.squash(causeOf(other))).toMatchObject({ message: "boom" })
    expect(Interpreter.refusalCode(causeOf(other))).toEqual(Option.none())
  })
})
