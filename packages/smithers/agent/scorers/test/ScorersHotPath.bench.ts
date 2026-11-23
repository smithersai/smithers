import { describe, test } from "vitest"
import * as Checks from "../src/Checks.ts"
import * as Rubric from "../src/Rubric.ts"

const sampleReply = Array.from(
  { length: 25 },
  (_, i) =>
    `Section ${i}: Updated [module-${i}](https://github.com/smithersai/smithers/blob/main/packages/pkg-${i}/src/index.ts) with full coverage and verified benchmark latency.`
).join("\n\n")

const criteria: ReadonlyArray<Rubric.Criterion> = [
  { id: "accuracy", question: "Are all claims factually accurate?", low: "Fabricated claims", high: "Fully verified" },
  {
    id: "conciseness",
    question: "Is the reply concise and actionable?",
    low: "Verbose prose",
    high: "Direct and crisp"
  },
  { id: "safety", question: "Does it respect trust boundaries?", low: "Leaks secrets", high: "No leaks" }
]

const judgeResponse = [
  "Evaluating against criteria...",
  `{"scores": {"accuracy": 5, "conciseness": 4, "safety": 5}, "reason": "Verified all facts and kept output concise."}`
].join("\n")

describe("scorers hot paths", () => {
  test("Checks suite evaluation", async ({ bench }) => {
    await bench("run words + length + links + barePaths + includes/excludes + all", () => {
      const checks = [
        Checks.length(sampleReply, { min: 50, max: 2000 }),
        Checks.includes(sampleReply, ["Section 0", "verified benchmark latency"]),
        Checks.excludes(sampleReply, ["TODO:", "FIXME:", "sk-live-"]),
        Checks.barePaths(sampleReply),
        Checks.truncated(sampleReply)
      ]
      Checks.links(sampleReply)
      Checks.all(checks)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Rubric.render, parse, and decide", async ({ bench }) => {
    await bench("render rubric prompt + parse JSON judgement + decide", () => {
      Rubric.render({
        criteria,
        context: "User asked for incremental benchmark wiring across 25 packages.",
        focus: "Check coverage, accuracy, and no leaked credentials.",
        output: sampleReply
      })
      const parsed = Rubric.parse(judgeResponse, criteria)
      if (parsed._tag === "Success") {
        Rubric.decide(parsed.success.scores, Rubric.defaultRule)
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
