import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer, Metric, Option, type Scope, Stream } from "effect"
import { recordUnhandled } from "../../boundary"
import { composerAccess } from "../auth/contract"
import { AuthStore, SESSION } from "../auth/store"
import { COMPOSER } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { ConversationsStore } from "../conversations/store"
import { PersonalModelStore } from "../personal-model/store"
import { steps } from "./metrics"
import { FIRST_RUN, FirstRunRow } from "./schema"
import { conversationsOf, firstRunOf, type FirstRun, HIDDEN, ownOf, rowOf, sameFirstRun, WAITING } from "./view"

// The first run on this tab (decision 0121, docs/features/first-run.md): one local row saying what `/app` shows in the
// composer's place, and a follower that works it out again (`firstRunOf`) whenever a row it reads changes: who is
// signed in and the session the device last confirmed (sign-in's), whether the person saved a model (your model's),
// their conversations (your conversations'), and whether the composer is open (chat's).
// Each step the row comes to show is a log line and a count. Should the follower ever stop, the row says `hidden`, so
// the composer's place shows the gate as it would without a first run.

const firstRunQuery = (row: Collection.Collection<FirstRunRow, string>) =>
  LiveQuery.make((q) => q.from({ firstRun: row.tanstack }).findOne())

export class FirstRunStore extends Context.Service<
  FirstRunStore,
  {
    readonly row: Collection.Collection<FirstRunRow, string>
    readonly state: Effect.Success<ReturnType<typeof firstRunQuery>>
    /** Where the follower runs, closed with the store. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/first-run/FirstRunStore") {
  /** The store, `wait` until the follower has read the rows it needs; its follower running until the scope closes. */
  static readonly layer = Layer.effect(
    FirstRunStore,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const auth = yield* AuthStore
      const model = yield* PersonalModelStore
      const conversations = yield* ConversationsStore
      const chat = yield* ChatStore
      const row = yield* Collection.local<FirstRunRow, string>({
        id: "first-run",
        schema: FirstRunRow,
        getKey: (each) => each.id,
        initialData: [rowOf(WAITING)],
      })

      // Whether the person's model rows are ready, as `ComposerGate` reads their live query's: restored or synced.
      let modelReady = false
      let shown: FirstRun = WAITING
      const write = (next: FirstRun) =>
        row.update(FIRST_RUN, (draft) => void Object.assign(draft, { show: next.show, at: next.at, steps: [...next.steps] }))

      const work = Effect.gen(function* () {
        const session = Option.getOrThrow(yield* auth.session.get(SESSION))
        const [confirmed] = yield* auth.confirmed.toArray
        const saved = yield* model.saved.toArray
        const search = (yield* conversations.search.toArray)[0]
        const composer = yield* chat.composer.get(COMPOSER)
        const own = ownOf(saved.length, modelReady)
        const next = firstRunOf({
          access: composerAccess(session, confirmed, own),
          hostedModel: session.hostedModel,
          own,
          conversations: conversationsOf(yield* conversations.mine.toArray, search?.loaded === true),
          composerOpen: Option.isSome(composer) && composer.value.open,
        })
        if (sameFirstRun(next, shown)) return
        const before = shown
        shown = next
        yield* write(next)
        if (next.show !== "steps" || (before.show === "steps" && before.at === next.at)) return
        const fields = { step: next.at!, steps: next.steps.length }
        yield* Effect.gen(function* () {
          yield* Metric.update(Metric.withAttributes(steps, { step: fields.step }), 1)
          yield* Effect.annotateCurrentSpan(fields)
          yield* Effect.logInfo("first_run.step").pipe(Effect.annotateLogs(fields))
        }).pipe(Effect.withSpan("first_run.step"))
      })

      const changed = <A>(stream: Stream.Stream<A>) => Stream.map(stream, () => undefined)
      yield* Stream.mergeAll(
        [
          changed(auth.session.changes({ initial: true })),
          changed(auth.confirmed.changes({ initial: true })),
          changed(model.saved.changes({ initial: true })),
          // Once the person's model rows are ready: before that, a person with none shows nothing, as the gate does.
          changed(Stream.fromEffect(Effect.ignore(model.saved.preload).pipe(Effect.andThen(Effect.sync(() => void (modelReady = true)))))),
          changed(conversations.mine.changes({ initial: true })),
          changed(conversations.search.changes({ initial: true })),
          changed(chat.composer.changes({ initial: true })),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.runForEach(() => work),
        (follower) => recordUnhandled(follower, "first-run", "fork"),
        // recorded: app.unhandled, by recordUnhandled just above; the gate then shows as without a first run.
        Effect.catchCause(() => Effect.ignore(write(HIDDEN))),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      return FirstRunStore.of({ row, state: yield* firstRunQuery(row), scope })
    }).pipe(Effect.annotateLogs({ feature: "first-run" })),
  )
}
