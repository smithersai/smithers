/** Request preparation is planning. The wiki is context planning reads when it
 * is published and fresh (planning-memory.ts); planning never generates it.
 * The stack service refreshes it with `coding/wiki` after every fold. */
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { PlanningInput, PreparePlan } from "./planning.vibe"
import { Plan } from "./schema.ts"

export const PrepareRequest = Flow.make("coding/PrepareRequest", {
  payload: PlanningInput,
  success: Plan,
  error: PreparePlan.errorSchema,
  body: Node.capture({}, (input) => PreparePlan.child(input))
})

export const preparationLayers = Interpreter.layer(PrepareRequest)
