import type { JournalEvent } from "@smthrs/journal"
import { ModelRequest } from "@smthrs/model"
import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as Compaction from "../src/Compaction.ts"
import { ContextWindow } from "../src/ContextWindow.ts"
import * as Tokens from "../src/Tokens.ts"
import * as Transcript from "../src/Transcript.ts"

const sampleSource = Array.from(
  { length: 250 },
  (_, i) => `export const compute${i} = (x: number): number => { return (x + ${i}) * 2; }`
).join("\n")

const multiBlockReply = [
  "First, inspect the directory tree and read the target file:",
  "```cell",
  `const files = await ctx.call("fs/list", { path: "src" })`,
  `const text = await ctx.call("fs/read", { path: files[0] })`,
  "```",
  "Now compute the updated output and complete:",
  "```ts",
  `const lines: ReadonlyArray<string> = text.split("\\n")`,
  `ctx.done({ lineCount: lines.length })`,
  "```"
].join("\n\n")

const window = ContextWindow.make({
  modelId: "bench-model",
  segments: Array.from({ length: 80 }, (_, i) => ({
    kind: "transcript" as const,
    zone: "tail" as const,
    content: [ModelRequest.Message.assistant(`Turn ${i} output with details`, { stopReason: "stop" })],
    tokens: { value: 1_500, estimated: false }
  }))
})

const summarizer: Compaction.Summarizer = {
  identity: "summary-v1",
  modelId: "summary-model",
  params: ModelRequest.GenerationParams.make({ temperature: 0 })
}

const summaryMessage = ModelRequest.Message.assistant("Compacted summary of turns 0..60.", { stopReason: "stop" })

const journalEntries: ReadonlyArray<JournalEvent.Entry> = Array.from({ length: 500 }, (_, seq) =>
  ({
    runId: "run-bench",
    seq,
    channel: "durable",
    eventId: `ev-${seq}`,
    eventType: seq % 5 === 0 ? `${Transcript.controlEventPrefix}turn` : "model.step",
    payload: seq % 5 === 0 ? { journalVersion: Transcript.journalVersion, turn: seq } : { ok: true },
    recordedAt: "2026-11-22T00:00:00.000Z"
  }) as unknown as JournalEvent.Entry)

describe("harness hot paths", () => {
  test("Cell.extract multi-block reply", async ({ bench }) => {
    await bench("extract mixed cell + ts fenced blocks", () => {
      Cell.extract(multiBlockReply)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Tokens.estimate on 16 KiB source", async ({ bench }) => {
    await bench("estimate tokens for 250-line TypeScript source", () => {
      Tokens.estimate(sampleSource)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Compaction selectPrefix + declare + apply", async ({ bench }) => {
    await bench("compact 80-segment context window", () => {
      const prefix = Compaction.selectPrefix(window, { keepRecent: 20_000 })
      const step = Effect.runSync(Compaction.declare(window, prefix, summarizer))
      Effect.runSync(Compaction.apply(window, step, summaryMessage))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Transcript.validateJournal", async ({ bench }) => {
    await bench("validate 500 journal entries", () => {
      Transcript.validateJournal(journalEntries)
    }).run({ time: 120, warmupTime: 30 })
  })
})
