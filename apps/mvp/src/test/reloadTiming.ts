import { Effect } from "effect"

/** Injects unload at the explicitly requested race boundary; never a readiness wait. */
export const reloadAfter = <A>(milliseconds: 0 | 100 | 300, reload: () => Promise<A>): Promise<A> =>
  Effect.runPromise(Effect.andThen(Effect.sleep(milliseconds), Effect.promise(reload)))
