import { Effect } from "effect"

// A browser program boundary using the same real logger as the app's applied observer.
Effect.runSync(Effect.logInfo("shape.initial.applied").pipe(
  Effect.annotateLogs({ source: "todos", repository: "smithersai/smithers" }),
))
