import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Clock, Context, Duration, Effect, Exit, FiberHandle, Layer, Metric, Option, Queue, type Scope, Stream } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { AuthStore } from "../auth/store"
import { ChatStore } from "../chat/store"
import { StatusStore } from "../status/store"
import { NOTIFICATIONS_SHAPE_ROUTE } from "./contract"
import { detailOf } from "./detail"
import { feedOf, follows, landed } from "./entries"
import { shown } from "./metrics"
import { detailQuery, feedQuery, listQuery, needsQuery, panelQuery, stackQuery, unreadQuery } from "./queries"
import { Detail, Entry, Notice, PANEL, Panel, Pending } from "./schema"

// The personal feed on this tab (decision 0009, docs/features/notifications.md#the-browser): the person's
// `notifications`, synced by Electric and kept on the device; the acts this device took that haven't synced back yet,
// kept on the device too; and the entries the views read, worked out from both, the clock and the conversation the tab
// shows (`feedOf`). Two followers run while the store lives:
// - the feed: works the entries out again whenever a row, an act or the conversation changes, and when a toast is due
//   to hide; forgets acts the rows show; records each toast once per version;
// - the watch: follows the branch and repository of each conversation the tab shows (`watch/set`, door `view`), once
//   per person per conversation per tab, for a Member (or while sign-in can't say who is signed in);
// - the detail: what the entry expanded in the notifications panel shows besides its row (`detailOf`), worked out again
//   whenever the entry, its answer, its run row or the tab's draft of the answer changes.

/** Where the feed syncs from: ChatApi's origin, the site's own. */
export interface AttentionConfig {
  readonly origin: string
}

/** Where Open takes the person: the router's navigate, as the host gives it. */
export class AttentionNavigation extends Context.Service<
  AttentionNavigation,
  { readonly navigate: (path: string) => void }
>()("@smthrs/mvp/attention/AttentionNavigation") {}

type Success<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** Whether an entry reads differently from what the tab holds. */
const changed = (old: Entry, next: Entry) =>
  (Object.keys(next) as ReadonlyArray<keyof Entry>).some((field) => old[field] !== next[field])

export class AttentionStore extends Context.Service<
  AttentionStore,
  {
    readonly notices: ElectricCollection.ElectricCollection<Notice>
    readonly pending: Collection.Collection<Pending, string>
    readonly entries: Collection.Collection<Entry, string>
    readonly stack: Success<typeof stackQuery>
    readonly stackHere: Success<typeof stackQuery>
    readonly list: Success<typeof listQuery>
    readonly listHere: Success<typeof listQuery>
    /** This tab's notifications panel: one row. */
    readonly panel: Collection.Collection<Panel, string>
    /** The expanded entry's detail: at most one row. */
    readonly details: Collection.Collection<Detail, string>
    readonly feed: Success<typeof feedQuery>
    readonly unread: Success<typeof unreadQuery>
    readonly needs: Success<typeof needsQuery>
    readonly panelState: Success<typeof panelQuery>
    readonly detail: Success<typeof detailQuery>
    /** Where the background work an action starts runs. */
    readonly scope: Scope.Scope
  }
>()("@smthrs/mvp/attention/AttentionStore") {
  /** The store, its followers running until the scope closes. Needs chat's, agent status's and sign-in's stores, and dispatch. */
  static readonly layer = (config: AttentionConfig) =>
    Layer.effect(
      AttentionStore,
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const chat = yield* ChatStore
        const { place } = chat
        const status = yield* StatusStore
        const auth = yield* AuthStore
        const flows = yield* FlowDispatch
        const notices = yield* ElectricCollection.make<Notice>({
          id: "notifications",
          schema: Notice,
          getKey: (row) => row.subject,
          syncMode: "eager",
          // Version 2: the kind `spend` (src/device/registry.ts).
          persist: { schemaVersion: 2 },
          shape: {
            url: `${config.origin}${NOTIFICATIONS_SHAPE_ROUTE}`,
            columnMapper: ElectricCollection.snakeCamelMapper(),
          },
        })
        const pending = yield* Collection.persisted<Pending, string>({
          id: "attention-pending",
          schema: Pending,
          getKey: (row) => row.id,
          schemaVersion: 1,
        })
        const entries = yield* Collection.local<Entry, string>({
          id: "attention-entries",
          schema: Entry,
          getKey: (row) => row.id,
        })
        const panel = yield* Collection.local<Panel, string>({
          id: "attention-panel",
          schema: Panel,
          getKey: (row) => row.id,
          initialData: [{ id: PANEL, open: false, expanded: null, focus: null, answer: 0 }],
        })
        const details = yield* Collection.local<Detail, string>({
          id: "attention-details",
          schema: Detail,
          getKey: (row) => row.id,
        })

        // The feed: worked out again on every change, and when the next toast is due to hide.
        const ticks = yield* Queue.unbounded<void>()
        const timer = yield* FiberHandle.make<void, never>()
        const recorded = new Set<string>()
        const work = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* notices.toArray
          const acts = yield* pending.toArray
          // Chat's place always holds its one row.
          const where = (yield* place.toArray)[0]!
          const feed = feedOf(rows, acts, now, where.conversationId)
          const before = new Map((yield* entries.toArray).map((entry) => [entry.id, entry]))
          const next = new Set(feed.entries.map((entry) => entry.id))
          const gone = [...before.keys()].filter((id) => !next.has(id))
          if (gone.length > 0) yield* entries.delete(gone)
          for (const entry of feed.entries) {
            const old = before.get(entry.id)
            if (old === undefined) yield* entries.insert(entry)
            else if (changed(old, entry)) {
              yield* entries.update(entry.id, (draft) => void Object.assign(draft, entry))
            }
            // Each toast that came to show, once per version: a log line and a count, never its words.
            const key = `${entry.id}:${entry.version}`
            if (entry.stack && !recorded.has(key)) {
              recorded.add(key)
              yield* Metric.update(Metric.withAttributes(shown, { state: entry.state }), 1)
              yield* Effect.logInfo("notifications.shown").pipe(
                Effect.annotateLogs({ subject: entry.id, version: entry.version, state: entry.state, kind: entry.kind }),
              )
            }
          }
          const done = landed(rows, acts)
          if (done.length > 0) yield* pending.delete(done)
          if (feed.nextAt === undefined) yield* FiberHandle.clear(timer)
          else {
            yield* FiberHandle.run(
              timer,
              Effect.sleep(Duration.millis(feed.nextAt - now)).pipe(
                Effect.andThen(Queue.offer(ticks, undefined)),
                Effect.asVoid,
              ),
            )
          }
        }).pipe(
          // Local collections refuse only rows their own schema rejects, which `feedOf` never makes: a bug, not a state.
          Effect.orDie,
        )
        yield* Stream.mergeAll(
          [
            Stream.map(notices.changes({ initial: true }), () => undefined),
            Stream.map(pending.changes({ initial: true }), () => undefined),
            Stream.map(place.changes({ initial: true }), () => undefined),
            Stream.fromQueue(ticks),
          ],
          { concurrency: "unbounded" },
        ).pipe(Stream.runForEach(() => work), Effect.forkIn(scope, { startImmediately: true }))

        // The watch: each conversation this tab shows, once per person, once sign-in says a Member is signed in, or
        // can't say (ChatApi decides then). Signed out, still loading, or below a Member, nothing is asked.
        const watched = new Set<string>()
        const watch = Effect.gen(function* () {
          // Sign-in's store and chat's place each always hold their one row.
          const session = (yield* auth.session.toArray)[0]!
          const shown = (yield* place.toArray)[0]!
          const key = `${session.login ?? ""}:${shown.conversationId ?? "home"}`
          if (!follows(session) || watched.has(key)) return
          // Reserve before forking: another emission must see this launch while its child is still scheduled.
          watched.add(key)
          yield* flows.dispatch("watch/set", { conversationId: shown.conversationId }, { door: "view" }).pipe(
            Effect.onExit((exit) => Effect.sync(() => {
              // A refused dispatch or failed flow is not a watch. A later place/session change may ask again.
              if (Exit.isFailure(exit) || exit.value._tag === "Failed") watched.delete(key)
            })),
            Effect.ignore,
            Effect.forkIn(scope),
          )
        })
        yield* Stream.merge(auth.session.changes({ initial: true }), place.changes({ initial: true })).pipe(
          Stream.runForEach(() => watch),
          Effect.forkIn(scope, { startImmediately: true }),
        )

        // The detail: the expanded entry, with what this device has of its run, worked out again on every change to them.
        const answerOf = (runId: string, conversationId: string | null) =>
          Effect.gen(function* () {
            const home = yield* chat.messages.get(runId)
            if (Option.isSome(home)) return home.value
            // A branch's run: its answer, if this tab opened that branch's conversation.
            const branch = conversationId === null ? undefined : chat.opened(conversationId)
            return branch === undefined ? undefined : Option.getOrUndefined(yield* branch.messages.get(runId))
          })
        const explain = Effect.gen(function* () {
          // The panel's one row is always there.
          const { expanded } = (yield* panel.toArray)[0]!
          const entry = expanded === null ? Option.none() : yield* entries.get(expanded)
          const before = yield* details.toArray
          const next = Option.isNone(entry)
            ? undefined
            : entry.value.runId === null
            ? detailOf({ entry: entry.value, message: undefined, run: undefined, local: undefined })
            : detailOf({
              entry: entry.value,
              message: yield* answerOf(entry.value.runId, entry.value.conversationId),
              run: Option.getOrUndefined(yield* status.runs.get(entry.value.runId)),
              local: Option.getOrUndefined(yield* status.local.get(entry.value.runId)),
            })
          const gone = before.filter((row) => row.id !== next?.id).map((row) => row.id)
          if (gone.length > 0) yield* details.delete(gone)
          if (next === undefined) return
          const old = before.find((row) => row.id === next.id)
          if (old === undefined) {
            yield* details.insert(next)
            return
          }
          // Field by field: a row the collection holds carries its own virtual fields besides the detail's.
          const fields = Object.keys(next) as ReadonlyArray<keyof Detail>
          if (fields.some((key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]))) {
            yield* details.update(next.id, (draft) => void Object.assign(draft, next))
          }
        }).pipe(
          // Local collections refuse only rows their own schema rejects, which `detailOf` never makes: a bug, not a state.
          Effect.orDie,
        )
        // Switch the subscription with the expanded entry. A branch answer can change without its notification,
        // run row, or the home conversation changing; opening that branch later also makes its messages available.
        const branchAnswers = Stream.mergeAll([
          Stream.map(panel.changes({ initial: true }), () => undefined),
          Stream.map(entries.changes(), () => undefined),
          Stream.map(place.changes(), () => undefined),
        ], { concurrency: "unbounded" }).pipe(
          Stream.mapEffect(() => Effect.gen(function* () {
            const { expanded } = (yield* panel.toArray)[0]!
            const entry = expanded === null ? Option.none() : yield* entries.get(expanded)
            const conversationId = Option.isSome(entry) ? entry.value.conversationId : null
            return conversationId === null ? undefined : chat.opened(conversationId)
          })),
          Stream.changes,
          Stream.switchMap((branch) => branch === undefined ? Stream.empty : branch.messages.changes({ initial: true })),
        )
        yield* Stream.mergeAll(
          [
            Stream.map(branchAnswers, () => undefined),
            Stream.map(panel.changes({ initial: true }), () => undefined),
            Stream.map(entries.changes(), () => undefined),
            Stream.map(chat.messages.changes(), () => undefined),
            Stream.map(status.runs.changes(), () => undefined),
            Stream.map(status.local.changes(), () => undefined),
          ],
          { concurrency: "unbounded" },
        ).pipe(Stream.runForEach(() => explain), Effect.forkIn(scope, { startImmediately: true }))

        return AttentionStore.of({
          notices,
          pending,
          entries,
          stack: yield* stackQuery(entries, "stack"),
          stackHere: yield* stackQuery(entries, "stackHere"),
          list: yield* listQuery(entries, "stack"),
          listHere: yield* listQuery(entries, "stackHere"),
          panel,
          details,
          feed: yield* feedQuery(entries),
          unread: yield* unreadQuery(entries),
          needs: yield* needsQuery(entries),
          panelState: yield* panelQuery(panel),
          detail: yield* detailQuery(details),
          scope,
        })
      }),
    )
}
