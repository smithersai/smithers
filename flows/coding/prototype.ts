/** Explicit disposable experiment. It can neither enter correction nor land. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, Schema } from "effect"
import { Poc, PocResult } from "./poc.ts"
import { PrepareRequest } from "./preparation.ts"
import { CodingError, RequestInput } from "./schema.ts"
import { AdmitSource } from "./source-admission.ts"

const Error = Schema.Union([PrepareRequest.errorSchema, Poc.errorSchema])
export const Prototype = Flow.make("coding/Prototype", {
  payload: RequestInput, success: PocResult, error: Error,
  body: input => PrepareRequest.child({ prompt: input.prompt, feedback: input.feedback ?? "" }).pipe(
    Node.bindPlanned(plan => AdmitSource.call({ plan })),
    Node.bindPlanned(plan => Poc.child({ plan, source: plan.observedHead }).pipe(
      Node.bindPlanned(result => Node.succeed(result).pipe(Node.andThen(AdmitSource.call({ plan })),
        Node.andThen(Node.succeed(result))))))
  )
})
const RefusePrototype = Action.make("coding/refuse-prototype", { payload: {}, success: PocResult, error: CodingError })
export const RunPrototype = Flow.make("coding/RunPrototype", {
  payload: Executable.Invocation, success: PocResult, error: Error,
  body: invocation => {
    const decoded = Schema.decodeUnknownOption(RequestInput)(invocation.input)
    return Option.isSome(decoded) ? Prototype.child(decoded.value) : RefusePrototype.call({})
  }
})
export const prototypeRegistration = Layer.mergeAll(Interpreter.layer(Prototype), Interpreter.layer(RunPrototype),
  RefusePrototype.toLayer(() => Effect.fail(new CodingError({ code: "invalid_plan", message: "A prototype needs a prompt" }))))
