import { describe, expect, it } from "@effect/vitest"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { NodeHost } from "@smthrs/platform-node"
import { Effect, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as TurnLog from "../src/TurnLog.vibe"

const request = ModelRequest.make({
  modelId: "m",
  system: [{ type: "text", text: "Teach." }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  params: {}
})

const question = Evaluator.BooleanQuestion.of({ instructions: "Done?" })

describe("TurnLog", () => {
  it.effect("numbers, stamps and counts turns by kind and step", () =>
    Effect.gen(function*() {
      const log = yield* TurnLog.make()
      expect(yield* log.summary()).toEqual({ total: 0, chat: 0, evaluation: 0, refused: 0, steps: {} })
      yield* log.chat(request, "plan")
      yield* log.chat(request, "plan", { hold: "k" })
      yield* log.record("evaluation", "route")
      yield* log.record("refused", "route", { error: "bad" })
      expect(yield* log.summary()).toEqual({
        total: 4,
        chat: 2,
        evaluation: 1,
        refused: 1,
        steps: { plan: 2, route: 2 }
      })
      const entries = yield* log.entries()
      expect(entries.map((entry) => entry.n)).toEqual([1, 2, 3, 4])
      expect(entries.every((entry) => !Number.isNaN(Date.parse(entry.at)))).toBe(true)
      expect(entries[1]).toMatchObject({ kind: "chat", step: "plan", model: "m", messageCount: 1, hold: "k" })
      expect(entries[1]).not.toHaveProperty("messages")
      expect(entries[3]).toMatchObject({ kind: "refused", error: "bad" })
    }))

  it.effect("appends each entry to an owner-only file as one JSON line, with messages when asked", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "turn-log-"))),
      (directory) =>
        Effect.gen(function*() {
          const file = join(directory, "turns.jsonl")
          const log = yield* TurnLog.make({ file, messages: true })
          yield* log.chat(request, "plan")
          yield* log.record("evaluation", "route", { n: 99, step: "forged" })
          const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
          expect(lines[0]).toMatchObject({
            n: 1,
            step: "plan",
            messages: [{ role: "system", content: "Teach." }, { role: "user", content: "hello" }]
          })
          // A detail never overwrites the log's own fields.
          expect(lines[1]).toMatchObject({ n: 2, kind: "evaluation", step: "route" })
          if (process.platform === "win32") {
            // The native owner rechecks the protected DACL on the opened inode.
            // Its Windows suite additionally proves read denial under a second
            // token with a readable control; POSIX mode bits cannot do that.
            const owner = yield* NodeHost.AtomicFileSystem.ownerPrivate
            yield* owner.append(file, "")
            expect(readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(lines)
          } else {
            expect(statSync(file).mode & 0o777).toBe(0o600)
          }
        }),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    ))

  it.effect("TurnLog.model logs a turn under its step before the wrapped model answers", () =>
    Effect.gen(function*() {
      const log = yield* TurnLog.make()
      const inner = Model.make({
        providerName: "p",
        stream: () => Stream.make({ type: "text-delta" as const, id: "t", text: "x" })
      })
      const model = TurnLog.model(inner, { log, step: () => "named" })
      expect(model.providerName).toBe("p")
      expect([...yield* Stream.runCollect(model.stream(request))]).toHaveLength(1)
      expect((yield* log.summary()).steps).toEqual({ named: 1 })
      expect(TurnLog.model(Model.make({ stream: () => Stream.empty }), { log, step: () => "x" }).providerName)
        .toBeUndefined()
    }))

  it.effect("TurnLog.evaluator logs answers, refusals, and an evaluation with no questions", () =>
    Effect.gen(function*() {
      const log = yield* TurnLog.make()
      const answering = TurnLog.evaluator({
        evaluate: () => Effect.succeed({ answers: { done: { type: "boolean", probability: 1 } }, latencyMs: 0 })
      }, { log })
      const failing = TurnLog.evaluator({
        evaluate: () => Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "no" }))
      }, { log })
      yield* answering.evaluate({ state: {}, questions: { done: question } })
      yield* answering.evaluate({ state: {}, questions: {} })
      expect((yield* Effect.flip(failing.evaluate({ state: {}, questions: { a: question, b: question } }))).message)
        .toBe("no")
      const entries = yield* log.entries()
      expect(entries.map(({ kind, step }) => [kind, step])).toEqual([
        ["evaluation", "done"],
        ["evaluation", "empty"],
        ["refused", "a,b"]
      ])
      expect(entries[0]).toMatchObject({ answers: { done: { type: "boolean", probability: 1 } } })
      expect(entries[2]).toMatchObject({ error: "no" })
    }))
})
