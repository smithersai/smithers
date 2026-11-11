/**
 * The TUI's timers. Each one is an Effect fiber that sleeps on the default
 * `Clock`, and the function it returns interrupts that fiber, which clears the
 * underlying wait at once. React effects, watchers, monitors and child-process
 * deadlines use these instead of `setTimeout` and `setInterval`. A wait that
 * must survive a restart belongs in a flow's durable `Sleep`, not here.
 */
import { Cause, Effect, Exit } from "effect"

/** Stops a timer. Calling it after the timer ran, or a second time, does nothing. */
export type Cancel = () => void

const fork = (effect: Effect.Effect<void>): Cancel => {
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

/** Calls `run` once, `ms` from now, unless cancelled first. */
export const after = (ms: number, run: () => void): Cancel => fork(Effect.sync(run).pipe(Effect.delay(ms)))

/** Calls `run` every `ms`, the first time `ms` from now, until cancelled. */
export const every = (ms: number, run: () => void): Cancel =>
  fork(Effect.sync(run).pipe(Effect.delay(ms), Effect.forever))
