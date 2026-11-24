/** The TUI process boundary shared by interactive, print and probe entry points. */
import { Cause, Effect, Exit, ManagedRuntime } from "effect"

export const tuiRuntime = {
  runPromise: Effect.runPromise,
  makeManagedRuntime: ManagedRuntime.make
}

/** Starts an imperative timer and returns its cancellation handle. */
export const startTimer = (effect: Effect.Effect<void>): () => void => {
  const fiber = Effect.runFork(effect)
  // A throwing callback stays an uncaught error, as it was under a host timer, not a silent fiber death.
  fiber.addObserver((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      queueMicrotask(() => {
        throw Cause.squash(exit.cause)
      })
    }
  })
  return () => {
    fiber.interruptUnsafe()
  }
}
