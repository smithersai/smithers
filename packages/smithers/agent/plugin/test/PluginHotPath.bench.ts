import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { describe, test } from "vitest"
import * as Manifest from "../src/Manifest.ts"
import * as When from "../src/When.ts"
import { queueManifest } from "./support/hostFacts.ts"

const sampleManifest = queueManifest()
const sampleManifestText = JSON.stringify(sampleManifest)

const whenExpressions = [
  "view == queue/queue && item.question && !focus.input",
  "view == queue/detail && item.open && !focus.input",
  "!focus.input && item.pending"
]

const parsedWhens = whenExpressions.map((expr) => Result.getOrThrow(When.parse(expr)))

const contexts: ReadonlyArray<When.Context> = [
  { view: "queue/queue", item: { question: true, open: false, pending: true }, focusInput: false },
  { view: "queue/detail", item: { question: false, open: true, pending: false }, focusInput: false },
  { view: "queue/queue", item: { question: true }, focusInput: true }
]

describe("plugin hot paths", () => {
  test("Manifest.parse and decode", async ({ bench }) => {
    await bench("parse + validate plugin manifest JSON", () => {
      Effect.runSync(Manifest.parse(sampleManifestText))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("When.parse", async ({ bench }) => {
    await bench("parse 3 when-clause expressions", () => {
      for (const expr of whenExpressions) {
        When.parse(expr)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("When.evaluate", async ({ bench }) => {
    await bench("evaluate 9 when-clause x context combinations", () => {
      for (const when of parsedWhens) {
        for (const ctx of contexts) {
          When.evaluate(when, ctx)
        }
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
