/**
 * Merge-queue pattern: land a set of members in one prioritized order, at a
 * concurrency the queue owns rather than the members.
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
 * The priority a member gets when it does not declare one.
 *
 * It matches the priority the old `<MergeQueue>` component gave its
 * descendants, so a queue that relied on that default keeps its ordering.
 *
 * @category constants
 * @since 0.1.0
 */
export const DefaultPriority = 1000

/**
 * What a failing member does to the members behind it.
 *
 * @category models
 * @since 0.1.0
 */
export type FailurePolicy = "halt" | "quarantine"

/**
 * One declared member of the queue.
 *
 * @category models
 * @since 0.1.0
 */
export interface Member {
  readonly id: string
  readonly flow: Flow.Any
  readonly priority?: number | undefined
}

/**
 * Configuration for {@link make}.
 *
 * `concurrency` defaults to 1: a merge queue serializes landings unless a
 * caller widens it deliberately. Only a `quarantine` queue may widen it: a
 * `halt` queue promises that no member behind a failure lands, and a batch
 * starts its members before any of them has failed, so `halt` above
 * concurrency 1 is refused. `priority` sets the default a member without its
 * own priority receives. `members` land in the order {@link ordered}
 * resolves.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly members: ReadonlyArray<Member>
  readonly concurrency?: number | undefined
  readonly priority?: number | undefined
  readonly failurePolicy: FailurePolicy
}

/**
 * One member at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeMember<I, Out, E, R> {
  readonly id: string
  readonly priority?: number | undefined
  readonly run: (args: {
    readonly id: string
    readonly priority: number
    readonly position: number
    readonly input: I
  }) => Effect.Effect<Out, E, R>
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R> {
  readonly members: ReadonlyArray<RuntimeMember<I, Out, E, R>>
  readonly concurrency?: number | undefined
  readonly priority?: number | undefined
  readonly failurePolicy: FailurePolicy
}

/**
 * A member that landed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Landed<Out> {
  readonly id: string
  readonly output: Out
}

/**
 * A member the queue held back because it failed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Quarantined<E> {
  readonly id: string
  readonly error: E
}

/**
 * What a queue pass landed and what it held back.
 *
 * `order` is the order the queue used, so a caller can see the queue's
 * decision even when every member landed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Out, E> {
  readonly landed: ReadonlyArray<Landed<Out>>
  readonly quarantined: ReadonlyArray<Quarantined<E>>
  readonly order: ReadonlyArray<string>
}

/**
 * A member with its effective priority and queue position resolved.
 *
 * @category models
 * @since 0.1.0
 */
export interface Position<M> {
  readonly id: string
  readonly priority: number
  readonly position: number
  readonly member: M
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const merge = (left: unknown, right: unknown): Record<string, unknown> => ({
  ...(left as Record<string, unknown>),
  ...(right as Record<string, unknown>)
})

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

/**
 * Resolves each member's effective priority and sorts the queue.
 *
 * Members land in descending priority, and members of equal priority land in
 * declaration order, so the queue's order is a function of the declaration
 * alone and never of which member became ready first.
 *
 * @category introspection
 * @since 0.1.0
 */
export const ordered = <M extends { readonly id: string; readonly priority?: number | undefined }>(
  members: ReadonlyArray<M>,
  priority: number
): ReadonlyArray<Position<M>> => {
  const refusal = priorityRefusal(members, priority)
  if (refusal !== undefined) throw refusal
  return members
    .map((member, index) => ({
      id: member.id,
      priority: member.priority ?? priority,
      position: index,
      member
    }))
    .sort((left, right) =>
      left.priority === right.priority ? left.position - right.position : right.priority - left.priority
    )
    .map((entry, index) => ({ ...entry, position: index }))
}

const priorityRefusal = (
  members: ReadonlyArray<{ readonly id: string; readonly priority?: number | undefined }>,
  priority: number
): PatternError | undefined => {
  for (const member of members) {
    const refusal = Compose.safeIntegerPriorityRefusal("MergeQueue", member.id, member.priority ?? priority)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

const validate = (
  members: ReadonlyArray<{ readonly id: string; readonly priority?: number | undefined }>,
  concurrency: number,
  priority: number,
  failurePolicy: FailurePolicy
): PatternError | undefined => {
  if (members.length === 0) {
    return new PatternError({ code: "invalid_decorator", message: "MergeQueue requires at least one member" })
  }
  const ids = members.map((member) => member.id)
  if (new Set(ids).size !== ids.length) {
    return new PatternError({ code: "invalid_decorator", message: "MergeQueue member ids must be unique" })
  }
  if (!bound(concurrency)) {
    return new PatternError({
      code: "invalid_decorator",
      message: "MergeQueue concurrency must be a positive safe integer"
    })
  }
  // A batch starts every member in it before any of them has failed, so a
  // halting queue wider than one member could land a member behind a
  // failure. The contract promises it never does, so halt stays serial.
  if (failurePolicy === "halt" && concurrency > 1) {
    return new PatternError({ code: "invalid_decorator", message: "MergeQueue halt requires concurrency 1" })
  }
  return priorityRefusal(members, priority)
}

/**
 * Builds the landing topology: the members in queue order, batched into
 * `Node.all` groups of `concurrency` members, with the batches sequenced.
 *
 * At the default concurrency of 1 the queue is a plain `Node.andThen` chain,
 * with no `Node.all` at all, so the declared plan admits exactly one landing at
 * a time. Each call carries `{ id, position, input }`, so a built graph names
 * each member's place in the queue.
 *
 * A member's effective priority reaches the plan as a `Node.priority`
 * annotation rather than as call input, which is what lets the scheduler start
 * the higher-priority ready landing first. Priority stays out of key material,
 * so raising a member's number without changing the resulting order re-uses the
 * same steps rather than re-landing the queue.
 *
 * `failurePolicy` picks the topology. Under `quarantine` every member gains a
 * recovery arm settling it as MergeQueue's `Quarantined` result, so a failing
 * member neither fails the chain nor interrupts the batch beside it: the
 * queue {@link run} lands. Under `halt` the chain has no continuation past a
 * failed member, and it is always the serial chain: a halting queue is refused
 * above concurrency 1, because a batch would start a member behind a failure
 * before the failure is known.
 *
 * The wire marker is `{ _tag: "Quarantined", id, error }`. The tag is the
 * declaration's alone: a plan carries a settled member beside arbitrary
 * successful values, so the marker has to say what it is. A runtime
 * {@link Quarantined} entry is `{ id, error }` and carries no tag, because
 * {@link run} returns landed and quarantined members in separate arrays.
 *
 * `make` throws a `PatternError` when there are no members, when two members
 * share an id, when `concurrency` is not a positive safe integer, when
 * `failurePolicy` is `halt` and `concurrency` is above 1, or when `priority`
 * is not a safe integer.
 *
 * `make` snapshots `members`, each member's `id`, `flow`, and `priority`, and
 * every option at the call, so a later edit to the caller's array, records,
 * or option object does not change the declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's members or options again.
  const snapshot: ReadonlyArray<Member> = options.members.map((member) => ({
    id: member.id,
    flow: member.flow,
    priority: member.priority
  }))
  const concurrency = options.concurrency ?? 1
  const priority = options.priority ?? DefaultPriority
  const failurePolicy = options.failurePolicy
  const invalid = validate(snapshot, concurrency, priority, failurePolicy)
  if (invalid !== undefined) throw invalid
  const queue = ordered(snapshot, priority)
  // Priority is deliberately absent: it reaches the plan as an annotation, and
  // an annotation never enters key material. What it changes, the order and
  // therefore each member's position, is captured through `members`.
  const captures = {
    members: queue.map((entry) => entry.id),
    concurrency,
    failurePolicy
  }
  const { name, description } = Compose.label(
    "mergeQueue",
    { members: captures.members, concurrency, failurePolicy },
    options
  )
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: queue.map((entry) => entry.member.flow),
    body: Node.capture(captures, (input) => {
      const landing = (entry: Position<Member>): Node.Node<unknown, unknown> => {
        const declared = Node.priority(
          call(entry.member.flow, {
            id: entry.id,
            position: entry.position,
            input
          }),
          entry.priority
        )
        if (failurePolicy === "halt") return declared
        // The arm goes on the member rather than on the join because a serial
        // queue has no join to put it on. Runtime results keep successful and
        // quarantined members in separate arrays, so this marker never
        // classifies an arbitrary successful value.
        return Node.catch(declared, {
          onFailure: Node.capture(
            { id: entry.id },
            (error: unknown) => Node.succeed({ _tag: "Quarantined", id: entry.id, error })
          )
        })
      }
      if (concurrency === 1) {
        const walk = (index: number): Node.Node<unknown, unknown> => {
          const current = landing(queue[index]!)
          if (index + 1 >= queue.length) return current
          return Node.andThen(
            current,
            Node.capture({ ...captures, member: queue[index + 1]!.id }, () => walk(index + 1))
          )
        }
        return walk(0)
      }
      const batchAt = (offset: number): Node.Node<unknown, unknown> => {
        const group = Object.fromEntries(
          queue.slice(offset, offset + concurrency).map((entry) => [entry.id, landing(entry)])
        ) as Record<string, Node.Any>
        // A plain join: only a quarantining queue reaches a batch, and every
        // member of one already carries its own recovery arm, so no member
        // can fail this join on the batch's behalf.
        return Node.all(group)
      }
      let batches = batchAt(0)
      for (let offset = concurrency; offset < queue.length; offset += concurrency) {
        const batch = batchAt(offset)
        batches = Node.andThen(
          batches,
          Node.capture(
            { ...captures, offset },
            (soFar) => Node.map(batch, Node.capture({ ...captures, offset }, (values) => merge(soFar, values)))
          )
        )
      }
      return batches
    })
  })
}

/**
 * Lands the members in queue order at the queue's concurrency.
 *
 * At the default concurrency of 1 the members land strictly one at a time, in
 * descending priority and then declaration order.
 *
 * Under `failurePolicy: "halt"` a failing member fails the queue and no member
 * behind it lands, which is why `halt` runs only at concurrency 1: a wider
 * queue would have started the next member before the failure was known.
 * `run` fails with a `PatternError` for `halt` above concurrency 1, before
 * any member starts. Under `"quarantine"` the failure is recorded, the member
 * does not land, and the members behind it still do. A quarantined entry is
 * `{ id, error }`, untagged, because `landed` and `quarantined` are separate
 * arrays.
 *
 * Both policies read the typed failure channel. A member that throws raises a
 * defect, which fails the queue under either policy and cancels the landings
 * still in flight.
 *
 * `run` snapshots `members`, each member's `id`, `priority`, and `run`, and
 * every option at the call, so a later edit to the caller's array, records,
 * or option object does not alter that run.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Out, E = never, R = never>(
  input: I,
  options: RuntimeOptions<I, Out, E, R>
): Effect.Effect<Result<Out, E>, E | PatternError, R> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the array, a member record, or the option object in between must
  // not reach it.
  const members: ReadonlyArray<RuntimeMember<I, Out, E, R>> = options.members.map((member) => ({
    id: member.id,
    priority: member.priority,
    run: member.run
  }))
  const concurrency = options.concurrency ?? 1
  const priority = options.priority ?? DefaultPriority
  const failurePolicy = options.failurePolicy
  const invalid = validate(members, concurrency, priority, failurePolicy)
  if (invalid !== undefined) return Effect.fail(invalid)
  const queue = ordered(members, priority)
  return Effect.map(
    Effect.forEach(
      queue,
      (entry) => {
        const attempt = entry.member.run({
          id: entry.id,
          priority: entry.priority,
          position: entry.position,
          input
        })
        const landed = Effect.map(attempt, (output) => ({ landed: true, id: entry.id, output }) as const)
        return failurePolicy === "quarantine"
          ? Effect.catch(landed, (error: E) => Effect.succeed({ landed: false, id: entry.id, error } as const))
          : landed
      },
      { concurrency }
    ),
    (outcomes) => ({
      landed: outcomes.flatMap((outcome) => outcome.landed ? [{ id: outcome.id, output: outcome.output }] : []),
      quarantined: outcomes.flatMap((outcome) => outcome.landed ? [] : [{ id: outcome.id, error: outcome.error }]),
      order: queue.map((entry) => entry.id)
    })
  )
}
