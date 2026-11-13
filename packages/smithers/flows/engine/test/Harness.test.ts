import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Effect, Exit, Option } from "effect"
import { pollUntil } from "./Harness.ts"

describe("pollUntil", () => {
  const suspended = new Flow.Suspended({})
  const complete = new Flow.Complete({ exit: Exit.succeed(42) })
  type Result = Flow.Result<number, never>
  const some = (result: Result) => Option.some(result)

  const scenarios: ReadonlyArray<{
    readonly name: string
    readonly samples: ReadonlyArray<Option.Option<Result>>
    readonly turns: number
    readonly expected: Option.Option<Result>
    readonly polls: number
  }> = [
    {
      name: "accepts an initial match without yielding",
      samples: [some(suspended)],
      turns: 0,
      expected: some(suspended),
      polls: 1
    },
    {
      name: "waits past non-matching results",
      samples: [Option.none(), some(complete), some(suspended)],
      turns: 2,
      expected: some(suspended),
      polls: 3
    },
    {
      name: "accepts a match on the final turn",
      samples: [Option.none(), some(suspended)],
      turns: 1,
      expected: some(suspended),
      polls: 2
    },
    {
      name: "returns none when no result arrives",
      samples: [Option.none()],
      turns: 2,
      expected: Option.none(),
      polls: 3
    },
    {
      name: "rejects a terminal result when suspension was required",
      samples: [some(complete)],
      turns: 2,
      expected: Option.none(),
      polls: 3
    },
    {
      name: "does not return a non-match at the polling limit",
      samples: [Option.none(), some(complete), some(suspended)],
      turns: 1,
      expected: Option.none(),
      polls: 2
    },
    {
      name: "rejects an initial non-match with no turn budget",
      samples: [some(complete)],
      turns: 0,
      expected: Option.none(),
      polls: 1
    }
  ]

  for (const scenario of scenarios) {
    it.effect(scenario.name, () =>
      Effect.gen(function*() {
        let polls = 0
        const poll = Effect.sync(() => scenario.samples[Math.min(polls++, scenario.samples.length - 1)]!)
        const result = yield* pollUntil(poll, (result) => result._tag === "Suspended", { turns: scenario.turns })
        expect(result).toEqual(scenario.expected)
        expect(polls).toBe(scenario.polls)
      }))
  }

  it.effect("preserves a poll failure", () =>
    Effect.gen(function*() {
      const error = new FlowRuntime.FlowExecutionNotFound({ code: "execution_not_found", executionId: "missing" })
      const failure = yield* pollUntil(Effect.fail(error), () => true, { turns: 2 }).pipe(Effect.flip)
      expect(failure).toBe(error)
    }))
})
