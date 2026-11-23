import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, test } from "vitest"
import { Bounded, MapReduce, ReviewLoop } from "../src/index.ts"

const mapMember = Flow.make("bench/map", {
  payload: { shard: Schema.Unknown, index: Schema.Unknown, input: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ shard }) => Node.succeed(shard)
})

const reduceMember = Flow.make("bench/reduce", {
  payload: { input: Schema.Unknown, mapped: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ mapped }) => Node.succeed(mapped)
})

const workerMember = Flow.make("bench/worker", {
  payload: { input: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ input }) => Node.succeed(input)
})

const mapReduceFlow = MapReduce.make({
  map: mapMember,
  reduce: reduceMember,
  concurrency: 8,
  onEmpty: "reduce"
})

const shards64 = Array.from({ length: 64 }, (_, index) => index)
const boundedMembers50: Record<string, Node.Any> = Object.fromEntries(
  Array.from({ length: 50 }, (_, index) => [`m-${index}`, workerMember.call({ input: index }) as Node.Any])
)

const boundedNode = Bounded.all(boundedMembers50, { concurrency: 8 })
const boundedHost = Flow.make("bench/bounded-host", {
  payload: { input: Schema.Unknown },
  success: Schema.Unknown,
  body: () => boundedNode as Node.Node<unknown, never, never>
})

type ErasedMember = Flow.Any & { readonly call: (payload: never) => Node.Node<unknown, unknown, never> }

const produceMember = Flow.make("bench/produce", {
  payload: { input: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ input }) => Node.succeed(input)
}) as unknown as ErasedMember

const reviewMember = Flow.make("bench/review", {
  payload: { output: Schema.Unknown },
  success: Schema.Unknown,
  body: () => Node.succeed({ approved: true })
}) as unknown as ErasedMember

const reviseMember = Flow.make("bench/revise", {
  payload: { output: Schema.Unknown, review: Schema.Unknown, round: Schema.Number },
  success: Schema.Unknown,
  body: ({ output }) => Node.succeed(output)
}) as unknown as ErasedMember

const reviewLoopFlow = ReviewLoop.make({
  produce: produceMember,
  review: reviewMember,
  revise: reviseMember,
  maxRounds: 10
})

describe("patterns", () => {
  test("Graph.build MapReduce (64 shards, concurrency 8)", async ({ bench }) => {
    await bench("MapReduce Graph.build 64", () => {
      Graph.build(mapReduceFlow, { shards: shards64 })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Graph.build Bounded.all (50 members, concurrency 8)", async ({ bench }) => {
    await bench("Bounded.all Graph.build 50", () => {
      Graph.build(boundedHost, { input: undefined })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Graph.build ReviewLoop (10 rounds)", async ({ bench }) => {
    await bench("ReviewLoop Graph.build 10", () => {
      Graph.build(reviewLoopFlow, { input: { topic: "bench" } })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("MapReduce.run (64 shards, concurrency 8)", async ({ bench }) => {
    const program = MapReduce.run(
      { shards: shards64 },
      {
        concurrency: 8,
        onEmpty: "reduce",
        map: ({ shard }) => Effect.succeed(shard * 2),
        reduce: ({ mapped }) => Effect.succeed(mapped.reduce((acc, value) => acc + value, 0))
      }
    )
    await bench("MapReduce.run 64", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("ReviewLoop.run (5 rounds to approval)", async ({ bench }) => {
    const program = ReviewLoop.run(
      { draft: "initial" },
      {
        maxRounds: 6,
        produce: (input) => Effect.succeed({ text: input.draft, round: 0 }),
        review: (_output, round) => Effect.succeed({ approved: round === 5 }),
        revise: ({ output, round }) => Effect.succeed({ text: `${output.text}-r${round}`, round })
      }
    )
    await bench("ReviewLoop.run 5 rounds", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })
})
