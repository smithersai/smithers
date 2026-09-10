/**
 * Supervisor pattern: one boss plans, workers execute in parallel, the boss
 * reviews, and only the tasks the review calls retriable are re-delegated.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * One unit of delegated work named by the plan.
 *
 * `workerType` selects which worker performs the task; `id` is the identity a
 * review names when it asks for the task to be re-delegated.
 *
 * @category models
 * @since 0.1.0
 */
export interface Task {
  readonly id: string
  readonly workerType: string
}

/**
 * A plan the supervisor delegates from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly tasks: ReadonlyArray<Task>
}

/**
 * Configuration for {@link make}.
 *
 * Workers are held in a record so their declared keys are stable worker-type
 * identities. The topology comes from the plan's task list, which the flow
 * input carries as `tasks`, and each task is routed to the worker its
 * `workerType` names. Rounds are unrolled at declaration time, so the plan
 * declares `maxRounds` rounds of one call per task and `maxRounds` reviews;
 * {@link run} performs the value-dependent short circuit.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly plan: Flow.Any
  readonly workers: Readonly<Record<string, Flow.Any>>
  readonly review: Flow.Any
  readonly finalize: Flow.Any
  readonly maxRounds: number
  readonly concurrency: number
}

/**
 * The result of one worker attempt.
 *
 * A worker failure is captured rather than propagated so the review sees every
 * task's outcome and can decide what to re-delegate.
 *
 * @category models
 * @since 0.1.0
 */
export type Outcome<Out> =
  | {
    readonly _tag: "Done"
    readonly id: string
    readonly workerType: string
    readonly round: number
    readonly output: Out
  }
  | {
    readonly _tag: "Failed"
    readonly id: string
    readonly workerType: string
    readonly round: number
    readonly error: unknown
  }

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, P extends Plan, Out, Review, Final, E, R, E2, R2, E3, R3, E4, R4> {
  readonly plan: (input: I) => Effect.Effect<P, E, R>
  readonly worker: (args: {
    readonly task: Task
    readonly plan: P
    readonly round: number
    readonly input: I
  }) => Effect.Effect<Out, E2, R2>
  readonly review: (args: {
    readonly plan: P
    readonly results: ReadonlyArray<Outcome<Out>>
    readonly round: number
    readonly input: I
  }) => Effect.Effect<Review, E3, R3>
  readonly finalize: (args: {
    readonly plan: P
    readonly results: ReadonlyArray<Outcome<Out>>
    readonly review: Review
    readonly rounds: number
    readonly input: I
  }) => Effect.Effect<Final, E4, R4>
  readonly maxRounds: number
  readonly concurrency: number
}

/**
 * A supervision that reached an accepted review and finalized.
 *
 * @category models
 * @since 0.1.0
 */
export interface Completed<Final> {
  readonly exhausted: false
  readonly rounds: number
  readonly final: Final
}

/**
 * A supervision that ran out of rounds, or whose last review named nothing to
 * re-delegate. `finalize` is not called.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<Review> {
  readonly exhausted: true
  readonly rounds: number
  readonly review: Review
}

const merge = (left: unknown, right: unknown): Record<string, unknown> => ({
  ...(left as Record<string, unknown>),
  ...(right as Record<string, unknown>)
})

const done = (value: unknown): boolean =>
  value === true ||
  (typeof value === "object" && value !== null && "allDone" in value && value.allDone === true)

const retriable = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null || !("retriable" in value)) return []
  const ids = value.retriable
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
}

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

// Task lists come from the flow input or from the plan a boss returned, so a
// malformed one is a data fault, not a declaration fault.
const invalid = (message: string): PatternError => new PatternError({ code: "invalid_input", message })

const validateTasks = (input: unknown): ReadonlyArray<Task> | PatternError => {
  if (typeof input !== "object" || input === null || !("tasks" in input) || !Array.isArray(input.tasks)) {
    return invalid("Supervisor input must contain a tasks array")
  }
  const tasks = input.tasks as ReadonlyArray<unknown>
  if (tasks.length === 0) return invalid("Supervisor input must contain at least one task")
  const snapshot: Array<Task> = []
  for (const task of tasks) {
    const candidate = task as { readonly id?: unknown; readonly workerType?: unknown }
    if (
      typeof task !== "object" || task === null ||
      typeof candidate.id !== "string" || typeof candidate.workerType !== "string"
    ) {
      return invalid("Supervisor tasks must each carry a string id and a string workerType")
    }
    snapshot.push({ id: candidate.id, workerType: candidate.workerType })
  }
  return snapshot
}

const planned = (input: unknown): ReadonlyArray<Task> => {
  const result = validateTasks(input)
  if (result instanceof PatternError) throw result
  return result
}

const retriableOf = (review: unknown): unknown =>
  review === null || review === undefined ? undefined : (review as { readonly retriable?: unknown }).retriable

/**
 * Builds the conservative supervision topology: one plan call, then per round
 * one call per planned task bounded by `concurrency`, one review, and one
 * finalize call.
 *
 * The task list comes from the flow input's `tasks`, so it is known while
 * planning, and each task is routed to the worker its `workerType` names. Every
 * round after the first carries the preceding review and its `retriable` ids
 * into each worker call, so the graph shows which review a re-delegation
 * depends on.
 *
 * Every call carries a `phase` so a built graph names what each node does.
 * The plan is a superset of any single execution: {@link run} stops at the
 * first accepted review and re-delegates only the retriable tasks.
 *
 * Building the flow throws a `PatternError` with code `invalid_input` when
 * the input carries no `tasks` array, when it is empty, when a task is missing
 * a string `id` or `workerType`, when two tasks share an id, or when a
 * `workerType` names no declared worker. A bound out of range or an empty
 * worker record is refused with `invalid_decorator`.
 *
 * `make` snapshots the boss flows, the worker record, and both bounds at the
 * call, so a later edit to the caller's options does not change the
 * declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const workers = Object.entries(options.workers)
  if (workers.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Supervisor requires at least one worker" })
  }
  if (!bound(options.maxRounds)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Supervisor maxRounds must be a positive safe integer"
    })
  }
  if (!bound(options.concurrency)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Supervisor concurrency must be a positive safe integer"
    })
  }
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. The worker record
  // is copied as own data properties, so a prototype-shaped worker type still
  // routes.
  const boss = { plan: options.plan, review: options.review, finalize: options.finalize }
  const routes: Readonly<Record<string, Flow.Any>> = Object.fromEntries(workers)
  const maxRounds = options.maxRounds
  const concurrency = options.concurrency
  const names = workers.map(([name]) => name)
  const captures = { maxRounds, concurrency, workers: names }
  const { name, description } = Compose.label("supervisor", { workers: names, maxRounds, concurrency }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [boss.plan, ...workers.map(([, flow]) => flow), boss.review, boss.finalize],
    body: Node.capture(captures, (input) => {
      const tasks = planned(input)
      const ids = tasks.map((task) => task.id)
      if (new Set(ids).size !== ids.length) throw invalid("Supervisor task ids must be unique")
      for (const task of tasks) {
        if (!Object.hasOwn(routes, task.workerType)) {
          throw invalid(`Supervisor has no worker named "${task.workerType}"`)
        }
      }
      return Node.andThen(
        Compose.call(boss.plan, { phase: "plan", input }),
        Node.capture({ ...captures, tasks: ids }, (plan) => {
          const work = (task: Task, round: number, review: unknown): Record<string, unknown> =>
            round === 1
              ? { phase: "work", task, round, plan, input }
              : { phase: "work", task, round, plan, input, review, retriable: retriableOf(review) }
          const batchAt = (offset: number, round: number, review: unknown): Node.Node<unknown, unknown> => {
            const members = Object.fromEntries(
              tasks.slice(offset, offset + concurrency).map((task) => [
                task.id,
                Compose.call(routes[task.workerType]!, work(task, round, review))
              ])
            )
            return Node.all(members)
          }
          const delegate = (round: number, review: unknown): Node.Node<unknown, unknown> => {
            let batched = batchAt(0, round, review)
            for (let offset = concurrency; offset < tasks.length; offset += concurrency) {
              const batch = batchAt(offset, round, review)
              batched = Node.andThen(
                batched,
                Node.capture(
                  { round, offset },
                  (soFar) => Node.map(batch, Node.capture({ round, offset }, (values) => merge(soFar, values)))
                )
              )
            }
            return batched
          }
          const visit = (round: number, previous: unknown): Node.Node<unknown, unknown> =>
            Node.andThen(
              delegate(round, previous),
              Node.capture({ ...captures, round }, (results) =>
                Node.andThen(
                  Compose.call(boss.review, { phase: "review", round, plan, results, input }),
                  Node.capture({ ...captures, round }, (review) =>
                    done(review) || round >= maxRounds
                      ? Compose.call(boss.finalize, {
                        phase: "finalize",
                        rounds: round,
                        plan,
                        results,
                        review,
                        input
                      })
                      : visit(round + 1, review))
                ))
            )
          return visit(1, undefined)
        })
      )
    })
  })
}

/**
 * Runs a supervision: plan once, then per round delegate the pending tasks
 * with bounded concurrency, review every task's latest outcome, and either
 * finalize or re-delegate the tasks the review named retriable.
 *
 * A typed worker failure is captured as a `Failed` outcome instead of failing
 * the supervision, so the review decides whether the task is worth another
 * round. Only a typed failure is an outcome: a worker defect, like an
 * interruption, fails the supervision and cancels the workers still in flight.
 * The supervision ends as {@link Exhausted} when the round bound is reached or
 * when an unaccepted review names no retriable task, because nothing is left
 * to re-delegate.
 *
 * `run` fails with a `PatternError` when the plan is malformed, empty, or
 * repeats a task id. Outcomes are keyed by task id, so a repeated id would
 * delegate twice and hand the review the same outcome twice.
 *
 * `run` snapshots every callback and both bounds at the call, so a later
 * edit to the option object does not alter that run. The plan a `plan`
 * callback returns is copied task by task when it is validated.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, P extends Plan, Out, Review, Final, E, R, E2, R2, E3, R3, E4, R4>(
  input: I,
  options: RuntimeOptions<I, P, Out, Review, Final, E, R, E2, R2, E3, R3, E4, R4>
): Effect.Effect<Completed<Final> | Exhausted<Review>, E | E3 | E4 | PatternError, R | R2 | R3 | R4> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const boss = { plan: options.plan, review: options.review, finalize: options.finalize }
  const worker = options.worker
  const maxRounds = options.maxRounds
  const concurrency = options.concurrency
  if (!bound(maxRounds) || !bound(concurrency)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Supervisor maxRounds and concurrency must be positive safe integers"
      })
    )
  }
  return Effect.gen(function*() {
    const plan = yield* boss.plan(input)
    const tasks = validateTasks(plan)
    if (tasks instanceof PatternError) return yield* Effect.fail(tasks)
    const ids = tasks.map((task) => task.id)
    if (new Set(ids).size !== ids.length) {
      return yield* Effect.fail(
        invalid("Supervisor task ids must be unique")
      )
    }
    const latest = new Map<string, Outcome<Out>>()
    const supervise = (
      pending: ReadonlyArray<Task>,
      round: number
    ): Effect.Effect<Completed<Final> | Exhausted<Review>, E3 | E4, R2 | R3 | R4> =>
      Effect.gen(function*() {
        const outcomes = yield* Effect.forEach(
          pending,
          (task) =>
            worker({ task, plan, round, input }).pipe(
              Effect.map((output): Outcome<Out> => ({
                _tag: "Done",
                id: task.id,
                workerType: task.workerType,
                round,
                output
              })),
              Effect.catch((error): Effect.Effect<Outcome<Out>> =>
                Effect.succeed({
                  _tag: "Failed",
                  id: task.id,
                  workerType: task.workerType,
                  round,
                  error
                })
              )
            ),
          { concurrency }
        )
        for (const outcome of outcomes) latest.set(outcome.id, outcome)
        // Round one visits every task and later rounds only replace entries,
        // so `latest` contains one outcome for every validated task here.
        const results = tasks.map((task) => latest.get(task.id)!)
        const review = yield* boss.review({ plan, results, round, input })
        if (done(review)) {
          const final = yield* boss.finalize({ plan, results, review, rounds: round, input })
          return { exhausted: false, rounds: round, final } satisfies Completed<Final>
        }
        const ids = retriable(review)
        const next = tasks.filter((task) => ids.includes(task.id))
        if (next.length === 0 || round === maxRounds) {
          return { exhausted: true, rounds: round, review } satisfies Exhausted<Review>
        }
        return yield* supervise(next, round + 1)
      })
    return yield* supervise(tasks, 1)
  })
}
