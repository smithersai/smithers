/**
 * The declaration side of `MapReduce`: its types, its payload schema and
 * `make`, which throws a `PatternError` for a declaration it cannot build.
 * `MapReduce.vibe` re-exports all of it beside `run`, the pattern's Effect form.
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "../PatternError.ts"
import * as Bounded from "./BoundedMake.ts"
import * as Compose from "./Compose.ts"
import * as Failure from "./Failure.ts"
import type { Member } from "./Member.ts"
import { call as callMember } from "./Member.ts"

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
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly map: Member<R>
  readonly reduce: Member<R>
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
 * The payload a declared map-reduce takes.
 *
 * `shards` must be an array. Its elements can have any shape.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Payload = Schema.Struct({ shards: Schema.Array(Schema.Unknown) })

/**
 * The declared form of a map-reduce flow.
 *
 * @category models
 * @since 0.1.0
 */
export type MapReduceFlow<R = never> = Flow.Flow<
  string,
  typeof Payload,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Makes a map-reduce flow.
 *
 * The flow input must be a literal `{ shards }` available while planning.
 * Each shard becomes its own map call.
 * `Bounded.all` sequences map batches to enforce the declared concurrency
 * bound. The reducer receives values in shard order.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): MapReduceFlow<R> => {
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
  const { name, description } = Compose.label("mapReduce", { concurrency, onEmpty }, options, [
    stages.map,
    stages.reduce
  ])
  const body = (input: { readonly shards: unknown }): Node.Node<unknown, unknown, R> => {
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
      // A declared failure, not a throw: a body that throws is reported as an
      // incomplete graph, while `run` fails `exhausted`.
      if (onEmpty === "fail") {
        return Node.fail(new PatternError({ code: "exhausted", message: "MapReduce received no shards" }))
      }
      return onEmpty === "succeed"
        ? Node.succeed([])
        : callMember(stages.reduce, { input, mapped: [] })
    }
    const shardCount = shards.length
    const mapped = Bounded.all(
      Object.fromEntries(shards.map((shard, index) => [
        `shard-${index}`,
        callMember(stages.map, { shard, index, input })
      ])),
      { concurrency }
    )
    // The joined record is a planned reference until the run produces it. A
    // planned value may be read by field and passed into a payload, which is
    // what keeps the reducer's `mapped` in shard order rather than completion
    // order without computing on anything.
    return Node.bindPlanned(
      mapped,
      Node.capture({ concurrency, onEmpty, shardCount }, (values) =>
        callMember(stages.reduce, {
          input,
          mapped: Array.from({ length: shardCount }, (_, index) => values[`shard-${index}`])
        }))
    )
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: Payload,
    success: Schema.Unknown,
    // The engine encodes a typed failure through this schema: the pattern's
    // own `PatternError`, and whatever a member it called failed with.
    error: Failure.schemaFor([PatternError], [stages.map, stages.reduce]) as typeof Schema.Unknown,
    body: Node.capture({ concurrency, onEmpty }, body)
  })
}
