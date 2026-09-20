/**
 * The prototype flow's host wiring.
 *
 * The flow itself is `prototype/flow.ts`, the file discovery reads: it
 * default-exports the `@smthrs/flow` flow, so there is no second declaration
 * and no delegate name joining the two.
 */
import { Interpreter } from "@smthrs/flow"
import Prototype from "./prototype/flow.ts"

export { Prototype }

export const prototypeRegistration = Interpreter.layer(Prototype)
