import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

/** Recursive admission violates the registration ownership invariant. */
class RegistrationFault extends Schema.TaggedError<RegistrationFault>()("@smthrs/engine/RegistrationFault", {
  flowName: Schema.String,
  message: Schema.String
}) {}

/** Registration ancestry omitted when invoking a registered body. @private */
export const CurrentRegistrations = Context.Reference<ReadonlyArray<{ readonly owner: object; readonly name: string }>>(
  "@smthrs/engine/CurrentRegistrations",
  { defaultValue: () => [] }
)

interface Gate {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

/**
 * Admits one registration per flow name at a time. A registration that
 * re-enters its own name's admission would wait on itself, so it dies.
 * @private
 */
export const makeRegistrationGate = () => {
  const gates = new Map<string, Gate>()
  const enter = (name: string) =>
    Effect.sync(() => {
      const gate = gates.get(name) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      gates.set(name, gate)
      gate.users++
      return gate
    })
  // Waiters count as users, so cancellation cannot replace the lock while
  // another admission still owns or awaits it.
  const leave = (name: string, gate: Gate) =>
    Effect.sync(() => {
      if (--gate.users === 0) gates.delete(name)
    })
  return <A, E, R>(name: string, admission: Effect.Effect<A, E, R>) =>
    Effect.flatMap(CurrentRegistrations, (ancestors) => {
      if (ancestors.some((entry) => entry.owner === gates && entry.name === name)) {
        const message = `Flow ${name} cannot recursively register itself while admission is in progress`
        return Effect.die(new RegistrationFault({ flowName: name, message }))
      }
      const admitting = [...ancestors, { owner: gates, name }]
      return Effect.acquireUseRelease(
        enter(name),
        (gate) => gate.semaphore.withPermit(admission).pipe(Effect.provideService(CurrentRegistrations, admitting)),
        (gate) => leave(name, gate)
      )
    })
}

