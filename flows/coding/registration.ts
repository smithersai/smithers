/** Repository configuration of existing flows, catalog and Effect layers. */
import { Action, Interpreter } from "@smthrs/flow"
import { Layer } from "effect"
import { catalogLayers } from "./catalog.ts"
import ImplementPlan from "./flow.ts"
import { policyLayers } from "./workflow.ts"

export { ImplementPlan }

/** Provide the deployment's catalog, then pass this registration to its runtime. */
export const registration = Layer.mergeAll(
  catalogLayers,
  policyLayers,
  Interpreter.layer(ImplementPlan)
).pipe(Layer.provideMerge(Action.layerImplementations))
