/** The third pass over a validated request: admit, clean, retain, append. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, Schema } from "effect"
import { CodingError } from "./schema.ts"
import { AdmitVibe, vibeAdmissionLayers } from "./vibe-admission.ts"
import { CleanVibeHistory, cleanupLayers } from "./vibe-cleanup.ts"
import { LandVibe, LandVibeError, landingLayers } from "./vibe-landing.ts"
import { VibeInput, VibeLanded } from "./vibe-schema.ts"

export const VibeError = Schema.Union([...CleanVibeHistory.errorSchema.members, ...LandVibeError.members])
/** Each child leaves its own source-qualified receipt for the existing cards. */
export const Vibe = Flow.make("coding/Vibe", {
  payload: VibeInput, success: VibeLanded, error: VibeError,
  body: input => AdmitVibe.child(input).pipe(
    Node.bindPlanned(admission => CleanVibeHistory.child(admission)),
    Node.bindPlanned(cleanup => LandVibe.child(cleanup)))
})
const RefuseVibe = Action.make("coding/refuse-vibe", { payload: {}, success: VibeLanded, error: CodingError })
export const RunVibe = Flow.make("coding/RunVibe", {
  payload: Executable.Invocation, success: VibeLanded, error: VibeError,
  body: invocation => {
    const decoded = Schema.decodeUnknownOption(VibeInput)(invocation.input)
    return Option.isSome(decoded) ? Vibe.child(decoded.value) : RefuseVibe.call({})
  }
})
/** Landing is supplied by the deployment; models by the host's evidence-only policy. */
export const vibeRegistration = Layer.mergeAll(Interpreter.layer(Vibe), Interpreter.layer(RunVibe),
  RefuseVibe.toLayer(() => Effect.fail(new CodingError({ code: "invalid_plan", message: "Vibe needs the completed native coding/Request execution ID" }))),
  vibeAdmissionLayers, cleanupLayers, landingLayers)
