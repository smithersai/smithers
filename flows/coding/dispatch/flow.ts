/**
 * The dispatched turn, end to end.
 *
 * Registered unconditionally by the host: unlike `coding/Request` it needs
 * no project configuration, no memory and no check table, because it makes no
 * plan and produces no receipts.
 */
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer } from "effect"
// The flow below is this module's own default export. Discovery reads the
// literal `export default Flow.make(` without importing the file, so the flow
// cannot also be a named const; the registration beside it reads the value
// back through this self-import, which resolves after this module evaluates.
import Dispatch from "./flow.ts"
import {
  AdmitDispatch, DispatchError, DispatchInput, dispatchLayers, type DispatchOptions, DispatchResult,
  DispatchTurn, ObserveDispatch
} from "../dispatch.ts"

export default Flow.make("coding/Dispatch", {
  description: "Run one dispatched agent turn in this workspace and answer with the assistant messages it produced.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: DispatchInput,
  success: DispatchResult,
  error: DispatchError,
  body: (input) =>
    AdmitDispatch.call(input).pipe(
      Node.andThen(DispatchTurn.call(input)),
      Node.bindPlanned((answer) => ObserveDispatch.call({ input, answer }))
    )
})

/** The non-model half of the door, plus the flow it drives. */
export const dispatchRegistration = (options: DispatchOptions) =>
  Layer.mergeAll(Interpreter.layer(Dispatch), dispatchLayers(options))
