/** Explicit disposable experiment. It can neither enter correction nor land. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Poc, PocResult } from "../poc.vibe"
import { PrepareRequest } from "../preparation.ts"
import { RequestInput } from "../schema.ts"
import { AdmitSource } from "../source-admission.vibe"

export default Flow.make("coding/Prototype", {
  description: "Create and retain a disposable source prototype without implementing or landing it.",
  capabilities: ["*"],
  payload: RequestInput,
  success: PocResult,
  error: Schema.Union([PrepareRequest.errorSchema, AdmitSource.errorSchema, Poc.errorSchema]),
  body: Node.capture({}, (input) =>
    PrepareRequest.child({ prompt: input.prompt, feedback: input.feedback ?? "" }).pipe(
      Node.bindPlanned(Node.capture({}, (plan) => AdmitSource.call({ plan }))),
      Node.bindPlanned(Node.capture({}, (plan) =>
        Poc.child({ plan, source: plan.observedHead }).pipe(
          Node.bindPlanned(
            Node.capture(
              {},
              (result) =>
                Node.succeed(result).pipe(Node.andThen(AdmitSource.call({ plan })), Node.andThen(Node.succeed(result)))
            )
          )
        )))
    ))
})
