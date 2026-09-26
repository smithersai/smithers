/**
 * Role budgets: each profile's `budget` enforced on every role task, and a
 * per-host cap on concurrent role tasks.
 *
 * {@link layer} wraps the `organization/role-task` implementation the way
 * `Authority.layer` does (and is installed inside it, so authority is
 * checked first). For one task it:
 *
 * - charges the task to the principal's daily ledger and to every principal
 *   up its hiring chain, so a hire's work counts against its parent's
 *   `tasksPerDay`; a charge is keyed by the task, so a correction round or a
 *   replay is not charged twice;
 * - waits for a permit of the host's cap and one of the principal's
 *   `budget.concurrency`;
 * - runs the task under {@link taskBudget}: the run's own `Agent` budget
 *   (whatever the host approved for the run) and, over it, the profile's
 *   `tokensPerTask`.
 *
 * A limit that stops a task never stops it silently: the task answers a
 * `blocked` result whose summary names the limit and whose escalation goes to
 * the principal's parent (or the assistant for a core role), so the flow
 * that asked stops with that reason in its receipt.
 *
 * @since 1.0.0
 */
import * as Budget from "@smthrs/agent/Budget"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Authority from "./Authority.ts"
import type * as Profile from "./Profile.ts"
import * as Roster from "./Roster.ts"

/**
 * One task's token accounting over the run's budget.
 *
 * A call is refused when the task has already spent `tokensPerTask`, or when
 * what it spent plus its largest call so far would pass it. Every question
 * the task's budget refuses is answered with a `BudgetExceeded` (scope
 * `tokens`, `fail`); every other question goes on to `shared`, and every
 * recorded call is recorded there too. Without `shared` (a composition that
 * approved no run budget) the task's ceiling stands alone. Step keys are
 * counted once, so a replayed step is accounted as it was the first time and
 * the same calls are allowed.
 *
 * @category budgets
 * @since 1.0.0
 */
export const taskBudget = (
  shared: Budget.Service | undefined,
  principal: string,
  tokensPerTask: number
): Budget.Service => {
  const counted = new Map<string, number>()
  let used = 0
  let largest = 0
  const refusal = (): Budget.Verdict | undefined => {
    const next = largest
    if (used < tokensPerTask && used + next <= tokensPerTask) return undefined
    const exceeded = new Budget.BudgetExceeded({
      scope: "tokens",
      onExceeded: "fail",
      used,
      reserved: 0,
      max: tokensPerTask,
      next,
      message: `${principal} has spent ${used} of its ${tokensPerTask} tokens for this task`
    })
    return { _tag: "refuse", exceeded, failure: exceeded }
  }
  const ask = <E, R>(stepKey: string | undefined, then: Effect.Effect<Budget.Verdict, E, R>) =>
    Effect.suspend(() => {
      if (stepKey !== undefined && counted.has(stepKey)) return then
      const refused = refusal()
      return refused === undefined ? then : Effect.succeed(refused)
    })
  const proceed = Effect.succeed<Budget.Verdict>({ _tag: "proceed" })
  const own = Effect.sync((): Budget.Usage => ({ tokens: used, calls: counted.size, largestCall: largest }))
  return {
    check: (stepKey) => ask(stepKey, shared === undefined ? proceed : shared.check(stepKey)),
    reserve: (stepKey) => ask(stepKey, shared === undefined ? proceed : shared.reserve(stepKey)),
    record: (stepKey, usage) =>
      Effect.andThen(
        Effect.sync(() => {
          if (counted.has(stepKey)) return
          const spent = Budget.tokensOf(usage)
          const tokens = Number.isFinite(spent) ? spent : 0
          counted.set(stepKey, tokens)
          used += tokens
          largest = Math.max(largest, tokens)
        }),
        shared === undefined ? Effect.void : shared.record(stepKey, usage)
      ),
    usage: shared === undefined ? own : shared.usage,
    usageOf: (runId) => shared === undefined ? own : shared.usageOf(runId)
  }
}

/**
 * Whether a role task failed because a budget refused a model call: the
 * failure, or anything it wraps, is a `BudgetExceeded` or a `Skipped`.
 *
 * @category budgets
 * @since 1.0.0
 */
export const exhaustion = (error: unknown): Option.Option<string> => {
  let current: unknown = error
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const tag = Reflect.get(current, "_tag")
    if (tag === "flows/agent/BudgetExceeded" || tag === Budget.skippedTag) {
      const message = Reflect.get(current, "message")
      return Option.some(typeof message === "string" && message !== "" ? message : "the task's budget is spent")
    }
    current = Reflect.get(current, "cause")
  }
  return Option.none()
}

/**
 * The result a task answers when a limit stops it: `blocked`, with the limit
 * as the summary and an escalation to whoever sees to the principal.
 *
 * @category budgets
 * @since 1.0.0
 */
export const blocked = (profile: Profile.Profile, reason: string): Profile.RoleResult => ({
  status: "blocked",
  summary: `budget: ${reason}`,
  fields: {},
  evidence: [{ kind: "record", ref: `budget/${profile.id}`, detail: reason }],
  handoffs: [],
  escalations: [{ to: profile.hiredBy === undefined ? "assistant" : "parent", reason: `budget: ${reason}` }],
  decisions: []
})

/**
 * One principal the ledger charges, with its daily task limit.
 *
 * @category ledger
 * @since 1.0.0
 */
export interface Charge {
  readonly principal: string
  readonly tasksPerDay: number
}

/**
 * What a charge found: `charged` when every principal had room (or the task
 * was already charged), otherwise the first principal at its limit.
 *
 * @category ledger
 * @since 1.0.0
 */
export type Charged =
  | { readonly _tag: "charged" }
  | { readonly _tag: "exceeded"; readonly principal: string; readonly tasksPerDay: number }

/**
 * A ledger that could not be read or written.
 *
 * @category errors
 * @since 1.0.0
 */
export class LedgerError extends Schema.TaggedError<LedgerError>()("@smthrs/organization/Budgets/LedgerError", {
  message: Schema.String
}) {}

/**
 * The daily task ledger.
 *
 * `charge` records `task` against every principal of `charges` for `day`,
 * all or nothing: when any of them has already been charged `tasksPerDay`
 * other tasks that day, nothing is recorded and the answer names it. A task
 * already recorded is `charged` again without counting twice.
 *
 * @category ledger
 * @since 1.0.0
 */
export interface LedgerService {
  readonly charge: (input: {
    readonly day: string
    readonly task: string
    readonly charges: ReadonlyArray<Charge>
  }) => Effect.Effect<Charged, LedgerError>
  readonly count: (day: string, principal: string) => Effect.Effect<number, LedgerError>
}

/**
 * The daily task ledger service.
 *
 * @category ledger
 * @since 1.0.0
 */
export class Ledger extends Context.Service<Ledger, LedgerService>()("@smthrs/organization/Budgets/Ledger") {}

/** Days to principals to the tasks charged to them. */
type Book = Record<string, Record<string, ReadonlyArray<string>>>

const apply = (
  book: Book,
  input: Parameters<LedgerService["charge"]>[0]
): readonly [Charged, Book | undefined] => {
  const day = book[input.day] ?? {}
  for (const charge of input.charges) {
    const tasks = day[charge.principal] ?? []
    if (!tasks.includes(input.task) && tasks.length >= charge.tasksPerDay) {
      return [{ _tag: "exceeded", principal: charge.principal, tasksPerDay: charge.tasksPerDay }, undefined]
    }
  }
  const next: Record<string, ReadonlyArray<string>> = { ...day }
  let changed = false
  for (const charge of input.charges) {
    const tasks = next[charge.principal] ?? []
    if (tasks.includes(input.task)) continue
    next[charge.principal] = [...tasks, input.task]
    changed = true
  }
  return [{ _tag: "charged" }, changed ? { ...book, [input.day]: next } : undefined]
}

/**
 * Days a ledger keeps: older days are dropped when a charge is written.
 *
 * @category ledger
 * @since 1.0.0
 */
export const retainedDays = 7

const prune = (book: Book): Book => {
  const days = Object.keys(book).sort().slice(-retainedDays)
  return Object.fromEntries(days.map((day) => [day, book[day]!]))
}

/**
 * A ledger held in memory, for tests and hosts without a state directory.
 *
 * @category ledger
 * @since 1.0.0
 */
export const makeLedgerMemory = (): Effect.Effect<LedgerService> =>
  Effect.gen(function*() {
    const lock = yield* Semaphore.make(1)
    let book: Book = {}
    return {
      charge: (input) =>
        lock.withPermits(1)(Effect.sync(() => {
          const [charged, next] = apply(book, input)
          if (next !== undefined) book = prune(next)
          return charged
        })),
      count: (day, principal) => Effect.sync(() => book[day]?.[principal]?.length ?? 0)
    }
  })

/**
 * The in-memory ledger as a layer.
 *
 * @category ledger
 * @since 1.0.0
 */
export const layerLedgerMemory: Layer.Layer<Ledger> = Layer.effect(Ledger)(makeLedgerMemory())

const BookSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Array(Schema.String)))
const decodeBook = Schema.decodeUnknownEffect(Schema.fromJsonString(BookSchema))

/**
 * A ledger in one JSON file (a host's state directory), written by rename so
 * a crash leaves the old or the new book. One in-process lock serializes
 * charges; the host is the file's only writer.
 *
 * @category ledger
 * @since 1.0.0
 */
export const layerLedgerFile = (options: { readonly file: string }): Layer.Layer<
  Ledger,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(Ledger)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const lock = yield* Semaphore.make(1)
    const failed = (what: string) => () => new LedgerError({ message: `the task ledger ${options.file} ${what}` })
    const read = Effect.gen(function*() {
      const exists = yield* fs.exists(options.file).pipe(Effect.mapError(failed("could not be checked")))
      if (!exists) return {}
      const text = yield* fs.readFileString(options.file).pipe(Effect.mapError(failed("could not be read")))
      return yield* decodeBook(text).pipe(Effect.mapError(failed("does not parse")))
    })
    const write = (book: Book) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(path.dirname(options.file), { recursive: true }).pipe(
          Effect.mapError(failed("directory could not be created"))
        )
        const temporary = `${options.file}.${process.pid}.tmp`
        yield* fs.writeFileString(temporary, `${JSON.stringify(book)}\n`, { mode: 0o600 }).pipe(
          Effect.mapError(failed("could not be written"))
        )
        yield* fs.rename(temporary, options.file).pipe(Effect.mapError(failed("could not be replaced")))
      })
    return {
      charge: (input) =>
        lock.withPermits(1)(Effect.gen(function*() {
          const [charged, next] = apply(yield* read, input)
          if (next !== undefined) yield* write(prune(next))
          return charged
        })),
      count: (day, principal) => Effect.map(read, (book) => book[day]?.[principal]?.length ?? 0)
    }
  }))

/**
 * The UTC calendar day of an instant, `YYYY-MM-DD`.
 *
 * @category ledger
 * @since 1.0.0
 */
export const dayOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10)

/**
 * Host options for {@link layer}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Role tasks this host runs at once, across every principal. */
  readonly maxConcurrentTasks: number
}

const decodePayload = Schema.decodeUnknownResult(Authority.RoleTaskPayload)

/**
 * Runs one role task under its principal's budget. A payload that does not
 * decode or a principal that does not resolve runs unchanged: authority, which
 * wraps this, has already refused it.
 */
const budgeted = <A, E, R>(
  raw: unknown,
  executionId: string | undefined,
  handler: Effect.Effect<A, E, R>,
  services: Context.Context<Authority.RosterRegistry | Ledger>,
  permits: (profile: Profile.Profile) => Effect.Effect<Semaphore.Semaphore>,
  host: Semaphore.Semaphore
): Effect.Effect<A | Profile.RoleResult, E | LedgerError, R> =>
  Effect.gen(function*() {
    const payload = decodePayload(raw)
    if (Result.isFailure(payload)) return yield* handler
    const registry = Context.get(services, Authority.RosterRegistry)
    const resolved = yield* Effect.result(registry.resolve(payload.success.revision, payload.success.principal))
    if (Result.isFailure(resolved)) return yield* handler
    const { profile, snapshot } = resolved.success
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    const execution = Option.isSome(instance) ? instance.value.executionId : executionId ?? ""
    const chain = Roster.hireChain(snapshot.roster.profiles, profile.id)
    const charged = yield* Context.get(services, Ledger).charge({
      day: dayOf(yield* Clock.currentTimeMillis),
      task: `${execution}/${payload.success.task.id}`,
      charges: chain.map((link) => ({ principal: link.id, tasksPerDay: link.budget.tasksPerDay }))
    })
    if (charged._tag === "exceeded") {
      return blocked(
        profile,
        charged.principal === profile.id
          ? `${profile.id} has run its ${charged.tasksPerDay} tasks for today`
          : `${profile.id}'s hirer ${charged.principal} has run its ${charged.tasksPerDay} tasks for today`
      )
    }
    const own = yield* permits(profile)
    const shared = yield* Effect.serviceOption(Budget.Budget)
    const budget = taskBudget(Option.getOrUndefined(shared), profile.id, profile.budget.tokensPerTask)
    return yield* handler.pipe(
      Effect.provideService(Budget.Budget, budget),
      Effect.catch((error) =>
        Option.match(exhaustion(error), {
          onNone: () => Effect.fail(error),
          onSome: (reason) => Effect.succeed(blocked(profile, reason))
        })
      ),
      host.withPermits(1),
      own.withPermits(1)
    )
  })

/**
 * Installs budget enforcement around every `organization/role-task`
 * implementation or flow `actions` registers. Install it inside
 * `Authority.layer`: `Authority.layer(Budgets.layer(RoleTask.layer, options))`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <A, E, R>(
  actions: Layer.Layer<A, E, R>,
  options: Options
): Layer.Layer<
  A,
  E,
  | Exclude<R, FlowRuntime.FlowRuntime | Action.Implementations>
  | FlowRuntime.FlowRuntime
  | Action.Implementations
  | Authority.RosterRegistry
  | Ledger
> => {
  const included = (name: string) => name === Authority.roleTaskTag
  return actions.pipe(
    Layer.provide(Layer.unwrap(Effect.gen(function*() {
      const services = yield* Effect.context<Authority.RosterRegistry | Ledger>()
      const host = yield* Semaphore.make(options.maxConcurrentTasks)
      const lock = yield* Semaphore.make(1)
      const principals = new Map<string, Semaphore.Semaphore>()
      const permits = (profile: Profile.Profile) =>
        lock.withPermits(1)(Effect.gen(function*() {
          const existing = principals.get(profile.id)
          if (existing !== undefined) {
            yield* Semaphore.resize(existing, profile.budget.concurrency)
            return existing
          }
          const created = yield* Semaphore.make(profile.budget.concurrency)
          principals.set(profile.id, created)
          return created
        }))
      return Layer.mergeAll(
        Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
          ...runtime,
          register: (flow, handler) =>
            runtime.register(
              flow,
              included(flow._tag)
                ? (payload, executionId) =>
                  budgeted(payload, executionId, handler(payload, executionId), services, permits, host)
                : handler
            )
        }))),
        Layer.effect(Action.Implementations)(Effect.map(Action.Implementations, (table) => ({
          ...table,
          add: (implementation, options) =>
            table.add(
              included(implementation.name)
                ? {
                  ...implementation,
                  action: (payload) =>
                    budgeted(payload, undefined, implementation.action(payload), services, permits, host)
                }
                : implementation,
              options
            )
        })))
      )
    })))
  )
}
