import { Effect, Metric } from "effect"
import type { ShownStep } from "./contract"
import { presses } from "./metrics"

// What a person does on the first run's list (docs/features/first-run.md). Each step's button is a link or the
// composer's own: Sign in with GitHub counts as sign-in's press (`smithers_web_sign_in_presses`), Chat ⌘K as a composer
// opening (`smithers_web_composer_opens`). Open settings is the list's own link, so its press is the first run's.

/** A press of the first run's button for `step`: a log line, a span and a count, before the link it is goes. */
export const press = (step: ShownStep) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(presses, { step }), 1)
    yield* Effect.annotateCurrentSpan({ step })
    yield* Effect.logInfo("first_run.press").pipe(Effect.annotateLogs({ step }))
  }).pipe(Effect.withSpan("first_run.press"), Effect.annotateLogs({ feature: "first-run" }))
