/**
 * Deterministic map-reduce declaration pattern.
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
 * Empty-input policy for {@link make}.
 *
 * `"fail"` deliberately reports `exhausted`: the caller explicitly chose a
 * spent-bound style failure for an input with no shards.
 *
 * @category models
 * @since 0.1.0
 */
export type OnEmpty = "reduce" | "succeed" | "fail"

/**
 * Configuration for {@link make}.
 *
 * Inputs to the resulting flow are `{ shards }`. Shard keys use their ordinal
 * (`shard-0`, `shard-1`, …), which makes the reduce input independent of
 * worker completion order.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly map: Flow.Any
  readonly reduce: Flow.Any
  readonly concurrency: number
  readonly onEmpty: OnEmpty
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Shard, Mapped, Reduced, E, R, E2, R2> {
  readonly map: (input: {
    readonly shard: Shard
    readonly index: number
    readonly input: I
  }) => Effect.Effect<Mapped, E, R>
  readonly reduce: (input: {
    readonly input: I
    readonly mapped: ReadonlyArray<Mapped>
  }) => Effect.Effect<Reduced, E2, R2>
  readonly concurrency: number
  readonly onEmpty: OnEmpty
}

/**
 * Makes a map-reduce flow.
 *
 * The flow input must be a literal `{ shards }` available while planning.
 * Each shard becomes its own map call.
 * Batches are sequenced to enforce the declared concurrency bound, while
 * members inside a batch fan out with `Node.all`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { map: options.map, reduce: options.reduce }
  const concurrency = options.concurrency
  const onEmpty = options.onEmpty
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "MapReduce concurrency must be a positive safe integer"
    })
  }
  const { name, description } = Compose.label("mapReduce", { concurrency, onEmpty }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [stages.map, stages.reduce],
    body: Node.capture({ concurrency, onEmpty }, (input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        !("shards" in input) ||
        !Array.isArray(input.shards)
      ) {
        throw new PatternError({
          code: "invalid_input",
          message: "MapReduce input must contain a shards array"
        })
      }
      const shards = input.shards as ReadonlyArray<unknown>
      if (shards.length === 0) {
        if (onEmpty === "fail") {
          throw new PatternError({ code: "exhausted", message: "MapReduce received no shards" })
        }
        return onEmpty === "succeed"
          ? Node.succeed([])
          : Compose.call(stages.reduce, { input, mapped: [] })
      }
      let mapped: Node.Node<ReadonlyArray<unknown>, unknown> = Node.succeed([])
      for (let offset = 0; offset < shards.length; offset += concurrency) {
        const members: Record<string, Node.Node<unknown, unknown>> = {}
        const batch = shards.slice(offset, offset + concurrency)
        batch.forEach((shard, batchIndex) => {
          const index = offset + batchIndex
          members[`shard-${index}`] = Compose.call(stages.map, { shard, index, input })
        })
        mapped = Node.andThen(
          mapped,
          Node.capture({ offset }, (previous) =>
            Node.map(
              Node.all(members),
              Node.capture({ offset }, (values) => [
                ...previous,
                ...Object.keys(values).sort((left, right) => Number(left.slice(6)) - Number(right.slice(6))).map((
                  key
                ) => values[key])
              ])
            ))
        )
      }
      return Node.andThen(
        mapped,
        Node.capture(
          { concurrency, onEmpty },
          (values) => Compose.call(stages.reduce, { input, mapped: values })
        )
      )
    })
  })
}

/**
 * Executes map work with bounded concurrency, preserves shard order, and
 * reduces the real mapped values.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <
  I extends { readonly shards: ReadonlyArray<unknown> },
  Mapped,
  Reduced,
  E,
  R,
  E2,
  R2
>(
  input: I,
  options: RuntimeOptions<I, I["shards"][number], Mapped, Reduced, E, R, E2, R2>
): Effect.Effect<Reduced | ReadonlyArray<Mapped>, E | E2 | PatternError, R | R2> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the shard array or the option object in between must not reach
  // it. The input itself is handed to the callbacks as the caller's object.
  const stages = { map: options.map, reduce: options.reduce }
  const concurrency = options.concurrency
  const onEmpty = options.onEmpty
  const shards: ReadonlyArray<I["shards"][number]> = [...input.shards]
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "MapReduce concurrency must be a positive safe integer"
      })
    )
  }
  if (shards.length === 0) {
    if (onEmpty === "fail") {
      return Effect.fail(new PatternError({ code: "exhausted", message: "MapReduce received no shards" }))
    }
    return onEmpty === "succeed"
      ? Effect.succeed([])
      : Effect.suspend(() => stages.reduce({ input, mapped: [] }))
  }
  return Effect.flatMap(
    Effect.forEach(
      shards,
      (shard, index) => stages.map({ shard, index, input }),
      { concurrency }
    ),
    (mapped) => stages.reduce({ input, mapped })
  )
}
