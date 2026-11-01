import { Clock, Effect, Layer, Option, Stream } from "effect"
import { recordUnhandled } from "../../boundary"
import { ADD_YOUR_MODEL } from "../auth/contract"
import { AuthStore, SESSION } from "../auth/store"
import { PersonalModelStore } from "../personal-model/store"
import { answers } from "../personal-model/view"
import { LOCAL_RECIPIENT, MODEL_NOTICE } from "./contract"
import { AttentionStore } from "./store"

/** This tab's prerequisite, derived again after reload. Hide lives only in the local launch row. */
export const syncModelNotice = (required: boolean) => Effect.gen(function* () {
  const { launches } = yield* AttentionStore
  const current = yield* launches.get(MODEL_NOTICE)
  if (!required) {
    if (Option.isSome(current)) {
      yield* launches.delete(MODEL_NOTICE)
      yield* Effect.logInfo("notifications.model").pipe(Effect.annotateLogs({ act: "resolved" }))
    }
    return
  }
  // An existing row also holds Hide. Recomputing prerequisites must never raise it again.
  if (Option.isSome(current)) return
  const now = yield* Clock.currentTimeMillis
  const at = new Date(now).toISOString()
  yield* launches.insert({
    subject: MODEL_NOTICE, recipient: LOCAL_RECIPIENT, kind: "run", state: "needs_you", mine: false, quiet: true,
    runId: null, repoId: null, conversationId: null, actor: null, title: ADD_YOUR_MODEL, ref: null,
    href: "/app/settings", version: now, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0,
    occurredAt: at, createdAt: at, updatedAt: at,
  })
}).pipe(Effect.orDie)

/** Follow the same routing readiness as the composer, independently of whichever page owns Notices. */
export const modelNotices = Layer.effectDiscard(Effect.gen(function* () {
  const auth = yield* AuthStore
  const model = yield* PersonalModelStore
  let ready = false
  const work = Effect.gen(function* () {
    const session = Option.getOrThrow(yield* auth.session.get(SESSION))
    yield* syncModelNotice(session.status === "signed_in" && session.hostedModel === false && ready && !answers(yield* model.saved.toArray))
  })
  yield* Stream.mergeAll([
    Stream.map(auth.session.changes({ initial: true }), () => undefined),
    Stream.map(model.saved.changes({ initial: true }), () => undefined),
    Stream.fromEffect(model.saved.preload.pipe(Effect.andThen(Effect.sync(() => { ready = true })))),
  ], { concurrency: "unbounded" }).pipe(
    Stream.runForEach(() => work),
    (follower) => recordUnhandled(follower, "model-notice", "fork"),
    Effect.forkScoped({ startImmediately: true }),
  )
}))
