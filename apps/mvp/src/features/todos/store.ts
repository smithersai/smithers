import { admissionReceipt } from "../../writeAdmission"
import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Persistence } from "@smthrs/effect-tanstack-db"
import { Cache, Clock, Context, Effect, Exit, Layer, Metric, Option, PubSub, Scope, Stream } from "effect"
import { AuthStore } from "../auth/store"
import { RepoStore } from "../repo/store"
import { repositoryShapeSource } from "../issues/source"
import { stackAccess } from "./source"
import { ChatStore } from "../chat/store"
import { repoId } from "../repo/contract"
import { sendingAdmitted } from "../../outboxAdmission"
import { TODO_REQUESTS_SHAPE_ROUTE, TODOS_SHAPE_ROUTE } from "./contract"
import {
  Access,
  Draft,
  type QueuedOp,
  type Requested,
  requestKey,
  type Sending,
  StackView,
  Todo,
  TodoRequest,
  VIEW,
} from "./schema"
import { deliveredOf } from "./view"
import { keep, StackWrites, TODO_OP } from "./writes"
import { admissions } from "./metrics"

// TODOs on this tab (decision 0016 §1, docs/features/todos.md#the-browser): each repository's TODOs and their prompts
// in Postgres, synced by Electric while a page shows that repository's stack and kept on the device; this device's own
// changes (src/features/todos/writes.ts); its private drafts, kept on the device; and what the route shows. Once a
// repository's stack opens, a follower drops each requested change whose result Electric delivered, and the shape's
// answers say whether this person may read it.

/** Where the TODOs sync from: ChatApi's origin. A failed request waits `SyncPolicy.defaultPolicy`. */
export interface TodosConfig {
  readonly origin: string
}

/** A row's key: its id. */
const byId = (row: { readonly id: string }): string => row.id

/** A live query of every row of `collection`. */
const rowsOf = <A extends object>(collection: { readonly tanstack: Collection.Collection<A, any>["tanstack"] }) =>
  LiveQuery.make((q) => q.from({ row: collection.tanstack }))

/** Every row of a collection of `A`, live. */
export type Rows<A extends object> = Effect.Success<ReturnType<typeof rowsOf<A>>>

/** One repository's stack on this tab: its synced TODOs and their prompts, live. */
export interface RepoStack {
  readonly todos: Rows<Todo>
  readonly requests: Rows<TodoRequest>
}

/**
 * The TODOs' state for one tab:
 * - `stackOf(repoId)`: a repository's TODOs and prompts, synced once a page opened them, for as long as the store lives;
 * - `opened(repoId)`: the same, if a page opened them, else none;
 * - `sending`, `requested`: this device's own changes (`StackWrites`);
 * - `drafts`: private drafts, kept on the device; `view`: what this tab's route shows; `access`: per repository;
 * - live queries of those for frontends, and `empty`, the rows of a stack not opened;
 * - `keepDraft` and `queue`: what a TODO step's tab does; `scope`, where a press's dispatch runs.
 */
export class TodosStore extends Context.Service<
  TodosStore,
  {
    readonly stackOf: (repoId: string) => Effect.Effect<RepoStack, Collection.LoadFailed>
    readonly opened: (repoId: string) => RepoStack | undefined
    /** The stacks this tab has opened; their stored TODOs remain results after recovery cleanup. */
    readonly openedStacks: () => ReadonlyArray<RepoStack>
    readonly empty: RepoStack
    readonly sending: Collection.Collection<Sending, string>
    readonly requested: Collection.Collection<Requested, string>
    readonly drafts: Collection.Collection<Draft, string>
    readonly view: Collection.Collection<StackView, string>
    readonly access: Collection.Collection<Access, string>
    readonly draftsQuery: Rows<Draft>
    readonly sendingQuery: Rows<Sending>
    readonly requestedQuery: Rows<Requested>
    readonly viewQuery: Effect.Success<ReturnType<typeof viewOf>>
    readonly accessQuery: Rows<Access>
    readonly keepDraft: (draft: Draft) => Effect.Effect<{ readonly kept: boolean }>
    readonly queue: (op: QueuedOp) => Effect.Effect<{ readonly kept: boolean }>
    readonly scope: Scope.Scope
    /** Once after any change to an opened stack's synced TODOs, its first rows included: what a commit's result reads on. */
    readonly todosChanged: Stream.Stream<void>
  }
>()("@smthrs/mvp/todos/TodosStore") {
  /** The store; its collections cleaned up and its shapes closed when the scope closes. Needs chat's store's outbox. */
  static readonly layer = (config: TodosConfig) => Layer.effect(TodosStore, make(config))
}

/** The one view row. */
const viewOf = (view: Collection.Collection<StackView, string>) =>
  LiveQuery.make((q) => q.from({ view: view.tanstack }).findOne())

const make = Effect.fnUntraced(function* (config: TodosConfig) {
  const scope = yield* Effect.scope
  const changedTodos = yield* PubSub.unbounded<void>()
  const auth = yield* AuthStore
  const repos = yield* RepoStore
  const persistence = yield* Persistence.Persistence
  // Stack shapes open later; retain the source supplied when this store was built.
  const source = yield* ShapeSource.ShapeSource
  const chat = yield* ChatStore
  const { sending, requested } = yield* StackWrites
  const drafts = yield* Collection.persisted<Draft, string>({
    id: "todo-drafts",
    schema: Draft,
    getKey: byId,
    schemaVersion: 1,
  })
  const view = yield* Collection.local<StackView, string>({
    id: "todo-view",
    schema: StackView,
    getKey: byId,
    initialData: [{ id: VIEW, owner: "", name: "", repoId: "", number: null, committing: [] }],
  })
  const access = yield* Collection.local<Access, string>({ id: "todo-access", schema: Access, getKey: byId })
  const requestedQuery = yield* rowsOf(requested)

  // A stack nobody opened: no rows, never a request.
  const nothing = yield* Collection.local<Todo, string>({ id: "todo-none", schema: Todo, getKey: byId })
  const noRequests = yield* Collection.local<TodoRequest, string>({
    id: "todo-requests-none",
    schema: TodoRequest,
    getKey: requestKey,
  })
  const empty: RepoStack = { todos: yield* rowsOf(nothing), requests: yield* rowsOf(noRequests) }

  // Each shape is ChatApi's proxy of one table for one repository, kept on the device.
  const shape = (route: string, id: string) => ({
    url: `${config.origin}${route}?repo=${encodeURIComponent(id.slice("github/".length))}`,
    columnMapper: ElectricCollection.snakeCamelMapper(),
  })
  // The stacks opened so far, by repository id, for frontends to read at once; each opens once (`opening`).
  const stacks = new Map<string, RepoStack>()
  const open = (id: string) =>
    Effect.gen(function* () {
      const authority = Stream.zipLatest(auth.sessionState.rows, repos.rolesState.rows).pipe(
        Stream.map(([sessions, roles]) => stackAccess(sessions[0]!, roles, id)), Stream.changes,
      )
      const guarded = repositoryShapeSource(source, authority)
      const todos = yield* ElectricCollection.make<Todo>({
        id: `todos:${id}`,
        schema: Todo,
        getKey: byId,
        shape: shape(TODOS_SHAPE_ROUTE, id),
        syncMode: "eager",
        // 4: a failure may be `base_closed` (stacked TODOs).
        persist: { schemaVersion: 4 },
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
      const requests = yield* ElectricCollection.make<TodoRequest>({
        id: `todo-requests:${id}`,
        schema: TodoRequest,
        getKey: requestKey,
        shape: shape(TODO_REQUESTS_SHAPE_ROUTE, id),
        syncMode: "eager",
        persist: { schemaVersion: 1 },
      }).pipe(Effect.provideService(ShapeSource.ShapeSource, guarded))
      const stack: RepoStack = { todos: yield* rowsOf(todos), requests: yield* rowsOf(requests) }
      yield* stack.todos.rows.pipe(
        Stream.runForEach(() => PubSub.publish(changedTodos, undefined)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // A requested change whose result arrived goes. Access follows the device session and repository role.
      yield* Stream.zipLatest(stack.todos.rows, requestedQuery.rows).pipe(
        Stream.runForEach(([rows, mine]) =>
          Effect.forEach(deliveredOf(id, rows, mine), (opId) => Effect.ignore(requested.delete(opId)), { discard: true })
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      // Unknown until the session and repository role answer.
      yield* Effect.ignore(access.insert({ id, status: "unknown" }))
      yield* Stream.zipLatestWith(
        authority,
        Stream.concat(Stream.make(false), Stream.fromEffect(Effect.as(todos.currentApplied, true))),
        (status, applied) => status === "allowed" && !applied ? "unknown" as const : status,
      ).pipe(
        Stream.runForEach((status) => Effect.ignore(access.update(id, (row) => { row.status = status }))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      stacks.set(id, stack)
      return stack
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(Persistence.Persistence, persistence),
      Effect.provideService(ShapeSource.ShapeSource, source),
    )
  // Opening a stack twice at once opens it once: the cache runs one lookup per repository and keeps it.
  const opening = yield* Cache.makeWith(open, {
    capacity: Number.MAX_SAFE_INTEGER,
    timeToLive: (exit) => Exit.isFailure(exit) ? 0 : Infinity,
  })
  const stackOf = (id: string) => Cache.get(opening, id)

  /** Keeps `draft` on the device once: a draft the device has already is kept. Answers whether the device has it. */
  const keepDraft = (draft: Draft) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* drafts.get(draft.id))) return { kept: true }
      const inserted = yield* drafts.insert(draft).pipe(Effect.result)
      return { kept: inserted._tag === "Success" }
    })

  /**
   * Puts `op` in the device's outbox once: a change it holds or the route took already is queued. This tab takes the
   * outbox's lead first, as a tab a person presses in does (decision 0002 §1), so the outbox admits it here. Answers
   * whether the outbox stored it.
   */
  const queue = (op: QueuedOp) =>
    Effect.gen(function* () {
      const flow = op.op === "retry" ? "todo/Retry" : `todo/${op.op}`
      const held = yield* requested.get(op.id)
      if (Option.isSome(yield* sending.get(op.id))) return { kept: yield* sendingAdmitted(chat.outbox, TODO_OP, op.id) }
      if (Option.isSome(held) && (held.value.status === "requested" || held.value.reason !== null)) return { kept: true }
      const [owner, name] = op.repo.split("/") as [string, string]
      const row: Sending = { ...op, repoId: repoId(owner, name), queuedAt: yield* Clock.currentTimeMillis, v: 2 }
      const recovery = yield* Effect.result(admissionReceipt(keep(requested, row, "not_sent", null, null), op.id, flow, "recovery"))
      if (recovery._tag === "Failure") {
        yield* recordAdmission(op, "storage_failed")
        return { kept: false }
      }
      yield* admissionReceipt(chat.lead, op.id, flow, "leader")
      const admitted = yield* chat.outbox
        .transact(TODO_OP, { idempotencyKey: op.id, joinExisting: true }, Effect.asVoid(sending.insert(row)))
        .pipe(Effect.flatMap((taken) => admissionReceipt(taken.admitted, op.id, flow, "storage").pipe(Effect.catch((error) => Effect.andThen(Effect.ignore(taken.settled), Effect.fail(error))))), Effect.result)
      const pending = yield* requested.get(op.id)
      if (admitted._tag === "Success" && Option.isSome(pending) && pending.value.status === "not_sent" && pending.value.reason === null) {
        const removed = yield* requested.delete(op.id).pipe(Effect.orDie)
        yield* Effect.ignore(removed.persisted)
      }
      yield* recordAdmission(op, admitted._tag === "Success" ? "queued" : "not_admitted")
      return { kept: admitted._tag === "Success" }
    })

  return TodosStore.of({
    todosChanged: Stream.fromPubSub(changedTodos),
    stackOf,
    opened: (id) => stacks.get(id),
    openedStacks: () => [...stacks.values()],
    empty,
    sending,
    requested,
    drafts,
    view,
    access,
    draftsQuery: yield* rowsOf(drafts),
    sendingQuery: yield* rowsOf(sending),
    requestedQuery,
    viewQuery: yield* viewOf(view),
    accessQuery: yield* rowsOf(access),
    keepDraft,
    queue,
    scope,
  })
})

const recordAdmission = (op: QueuedOp, outcome: "queued" | "not_admitted" | "storage_failed") => Effect.gen(function* () {
  yield* Metric.update(Metric.withAttributes(admissions, { op: op.op, outcome }), 1)
  yield* Effect.logInfo("todos.write.admission").pipe(Effect.annotateLogs({ opId: op.id, op: op.op, outcome }))
})
