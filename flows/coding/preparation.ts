/** Host-owned selection of optional generated knowledge. The request payload
 * cannot enable Wiki generation or bypass source and check admission. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { PrepareWithWiki } from "./planning-wiki.ts"
import { PlanningInput, PreparePlan } from "./planning.ts"
import { CodingError, Plan } from "./schema.ts"

export const UsePlanningWiki = Action.make("coding/use-planning-wiki", {
  payload: {}, success: Schema.Boolean, error: CodingError
})

export const PrepareRequest = Flow.make("coding/PrepareRequest", {
  payload: PlanningInput, success: Plan, error: PrepareWithWiki.errorSchema,
  body: input => UsePlanningWiki.call({}).pipe(Node.branch({
    if: enabled => enabled,
    then: () => PrepareWithWiki.child(input),
    else: () => PreparePlan.child(input)
  }))
})

export const preparationLayers = (wiki = false) => Layer.mergeAll(
  Interpreter.layer(PrepareRequest), UsePlanningWiki.toLayer(() => Effect.succeed(wiki))
)
