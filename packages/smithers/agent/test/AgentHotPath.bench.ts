import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, test } from "vitest"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import * as SeatRouter from "../src/SeatRouter.ts"
import * as Transcript from "../src/Transcript.ts"
import * as WorkspaceObservation from "../src/WorkspaceObservation.ts"

const scrub = Transcript.scrubber(["sk-live-secret-token-1234567890", "ghp_secretTokenValue987654321"])

const largeTextUpdate = {
  content: {
    type: "text",
    text: Array.from(
      { length: 200 },
      (_, i) => `line ${i}: token sk-live-secret-token-1234567890 status ok payload=${i * 17}`
    ).join("\n")
  },
  metadata: {
    runId: "run-bench-1",
    step: 42,
    note: "auth ghp_secretTokenValue987654321"
  }
}

const routeCases: ReadonlyArray<SeatRouter.Answers> = [
  { phase: "plan", size: "important", clarity: "unknowns", binary: false },
  { phase: "implement", size: "middle", clarity: "clear", binary: true },
  { phase: "review", size: "important", clarity: "clear", binary: false },
  { phase: "tool", size: "trivial", clarity: "clear", binary: true },
  { phase: "ui", size: "simple", clarity: "unknowns", binary: false }
]

const availableSeats = ["opus", "fable", "sol", "sonnet", "kimi", "luna"] as const

const quotaMessages = [
  "Rate limit exceeded. Please try again in 45s.",
  "Too many requests, retry after 2m30s",
  "Quota reached; resets in 1200ms"
]

describe("agent hot paths", () => {
  let dir = ""

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "smithers-agent-bench-"))
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(dir, `file-${i}.ts`), `export const value${i} = ${i}\n`)
    }
  })

  afterAll(() => {
    if (dir !== "") {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("Transcript.prepare scrub and chunk", async ({ bench }) => {
    await bench("prepare large scrubbed update", () => {
      Transcript.prepare("message_chunk", largeTextUpdate, scrub)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("SeatRouter.plan and fit", async ({ bench }) => {
    await bench("plan + fit 5 routing decisions", () => {
      for (const answers of routeCases) {
        const planned = SeatRouter.plan(answers)
        SeatRouter.fit(planned, answers.phase, availableSeats)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("QuotaPolicy.parseDelay", async ({ bench }) => {
    await bench("parse rate-limit delay strings", () => {
      for (const message of quotaMessages) {
        QuotaPolicy.parseDelay(message)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("WorkspaceObservation.observe", async ({ bench }) => {
    const program = Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* WorkspaceObservation.observe(fs, dir)
    }).pipe(Effect.provide(NodeFileSystem.layer))

    await bench("observe 60-file workspace tree", async () => {
      await Effect.runPromise(program)
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })
})
