import { Context, Effect } from "effect"

/** The real API in the browser proof; faulty Effect services exercise cleanup failures independently. */
export class SharingCleanup extends Context.Service<SharingCleanup, {
  readonly remove: (grantee: string) => Effect.Effect<void, Error>
  readonly discover: Effect.Effect<ReadonlyArray<string>, Error>
}>()("e2e/SharingCleanup") {}

/** Known writes precede discovery. Every reachable grant is attempted even when another operation fails. */
export const clearGrants = (known: ReadonlyArray<string>) => Effect.gen(function* () {
  const api = yield* SharingCleanup
  const failures: Error[] = []
  const removed = new Set<string>()
  const remove = (grantee: string) => Effect.gen(function* () {
    const result = yield* Effect.result(api.remove(grantee))
    if (result._tag === "Success") removed.add(grantee)
    else failures.push(result.failure)
  })
  for (const grantee of new Set(known)) yield* remove(grantee)
  const discovered = yield* Effect.result(api.discover)
  if (discovered._tag === "Failure") failures.push(discovered.failure)
  else for (const grantee of new Set(discovered.success)) {
    if (!removed.has(grantee)) yield* remove(grantee)
  }
  if (failures.length > 0) return yield* Effect.fail(new AggregateError(failures, "Sharing fixture cleanup failed"))
})
