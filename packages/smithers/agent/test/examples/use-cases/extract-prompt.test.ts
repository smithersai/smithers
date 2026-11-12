import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtractPrompt, layer } from "../../../examples/use-cases/extract-prompt.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "extract-prompt-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A person who answers each question the run parks on with the next of
 * `answers`, recording each question's prompt. It runs beside the run on the
 * same engine and answers through `HumanTask.answer`, as an inbox would.
 */
const person = (executionId: string, answers: ReadonlyArray<string>, questions: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const answered = new Set<string>()
      for (const value of answers) {
        const rows = yield* state.waitingTree(executionId).pipe(
          Effect.repeat({
            until: (rows) =>
              rows.some((row) => row.reason === "approval" && row.token !== null && !answered.has(row.token)),
            schedule: Schedule.spaced(10)
          })
        )
        const row = rows.find((row) => row.reason === "approval" && row.token !== null && !answered.has(row.token))!
        answered.add(row.token!)
        const request = typeof row.request === "string" ? JSON.parse(row.request) : row.request
        questions.push(request.prompt)
        yield* HumanTask.answer({ token: DurableDeferred.Token.make(row.token!), value })
      }
    }).pipe(Effect.orDie)
  ))

const slots = (task: string) => ({
  role: "a release engineer",
  context: "a monorepo with weekly releases",
  task,
  format: "a markdown checklist",
  constraints: [],
  successCriteria: [],
  outOfScope: []
})

/**
 * A drafter whose `n`-th draft scores `scores[n - 1]`, numbers itself in
 * `scoreReason`, folds the person's last answer into its task slot, and asks a
 * numbered question. Told to "ship it", it resolves as an override, keeping
 * its score and asking nothing. With `claimsResolved`, every other draft
 * claims to be resolved too. Each draft request is recorded with the prior draft's
 * number, the banner it was shown and the answer it was handed.
 */
const script = (scores: ReadonlyArray<number>, options: { readonly claimsResolved?: boolean } = {}) => {
  const drafts: Array<{ readonly prior: string; readonly banner: string; readonly answer: string | undefined }> = []
  const answer: Kit.Script = (asked) => {
    if (!asked.includes("You are a prompt extraction agent")) return undefined
    const prior = /## Prior draft\n```json\n([\s\S]*?)\n```/.exec(asked)
    const priorDraft = prior === null ? undefined : JSON.parse(prior[1]!)
    const banner = /## Score banner \(current state from the loop\)\n\n(.+)/.exec(asked)![1]!
    const reply = /## The user's answer to your last question\n(.+)/.exec(asked)?.[1]
    const n = priorDraft === undefined ? 1 : Number(/draft (\d+)/.exec(priorDraft.scoreReason)![1]) + 1
    drafts.push({ prior: priorDraft === undefined ? "none" : priorDraft.scoreReason, banner, answer: reply })
    const score = scores[n - 1]!
    if (reply === "ship it") {
      return {
        prompt: "You are a release engineer. write release notes.",
        structured: slots("write release notes"),
        score,
        scoreReason: `draft ${n}`,
        nextQuestion: "",
        nextPrinciple: "none",
        resolved: true,
        overridden: true,
        overrideReason: reply
      }
    }
    const task = reply === undefined ? "write release notes" : `write release notes for ${reply}`
    return {
      prompt: `You are a release engineer. ${task}.`,
      structured: slots(task),
      score,
      scoreReason: `draft ${n}`,
      nextQuestion: `Question ${n}: who reads the notes?`,
      nextPrinciple: "definition",
      resolved: options.claimsResolved === true,
      overridden: false,
      overrideReason: null
    }
  }
  return { answer, drafts }
}

it.effect("passes a provided prompt through without asking anyone", () =>
  Effect.gen(function*() {
    const prompt = "You are a release engineer. Write the 1.4 release notes as a markdown checklist."
    const draft = yield* Kit.run(ExtractPrompt, { prompt, stakes: "high" }, {
      filename: join(directory, "provided.sqlite"),
      executionId: "extract-prompt-provided",
      script: () => undefined,
      actions: layer
    })

    expect(draft).toEqual({
      prompt,
      structured: { role: "", context: "", task: "", format: "", constraints: [], successCriteria: [], outOfScope: [] },
      score: 1,
      scoreReason: "Provided directly by caller; no extraction performed.",
      nextQuestion: "",
      nextPrinciple: "none",
      resolved: true,
      overridden: false,
      overrideReason: null
    })
  }))

it.effect("passes a cache hit through, keeping its slots and its override", () =>
  Effect.gen(function*() {
    const draft = yield* Kit.run(ExtractPrompt, {
      prompt: "release notes",
      cached: {
        key: "release-notes",
        prompt: "You are a release engineer. Write the release notes.",
        structured: slots("write release notes"),
        schema: "rctf",
        stakes: "low",
        score: 0.6,
        scoreReason: "format is thin",
        createdAt: "2026-10-01T00:00:00Z",
        source: "extracted",
        overridden: true
      }
    }, {
      filename: join(directory, "cached.sqlite"),
      executionId: "extract-prompt-cached",
      script: () => undefined,
      actions: layer
    })

    // The provided prompt was too short to pass through, so the cache answered.
    expect(draft.prompt).toBe("You are a release engineer. Write the release notes.")
    expect(draft.structured).toEqual(slots("write release notes"))
    expect(draft.scoreReason).toBe("cached: format is thin")
    expect(draft.overridden).toBe(true)
    expect(draft.resolved).toBe(true)
  }))

// `it.live`: the person polls the engine's waiting row on a schedule, and a
// test clock nobody advances would leave that poll asleep forever.
it.live("asks the draft's question and refines with the answer until the threshold", () =>
  Effect.gen(function*() {
    const { answer, drafts } = script([0.5, 0.9])
    const questions: Array<string> = []
    const executionId = "extract-prompt-loop"
    const draft = yield* Kit.run(ExtractPrompt, { context: "We ship weekly." }, {
      filename: join(directory, "loop.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(layer, person(executionId, ["the on-call engineer"], questions))
    })

    // The person was asked the first draft's question, and the second draft
    // was handed that draft, its below-threshold banner and the answer.
    expect(questions).toEqual(["Question 1: who reads the notes?"])
    expect(drafts).toEqual([
      { prior: "none", banner: "Score: pending. Threshold: 0.7 (stakes: low).", answer: undefined },
      {
        prior: "draft 1",
        banner: "⚠ Score 0.50 < threshold 0.7 (stakes: low). Not yet ready by my judgment.",
        answer: "the on-call engineer"
      }
    ])
    expect(draft.scoreReason).toBe("draft 2")
    expect(draft.structured.task).toBe("write release notes for the on-call engineer")
  }), { timeout: 60_000 })

it.live("settles with the last draft when high stakes are not met by the bound", () =>
  Effect.gen(function*() {
    const { answer, drafts } = script([0.9, 0.95, 0.99])
    const questions: Array<string> = []
    const executionId = "extract-prompt-bound"
    const draft = yield* Kit.run(ExtractPrompt, { stakes: "high", maxTurns: 2 }, {
      filename: join(directory, "bound.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(layer, person(executionId, ["engineers"], questions))
    })

    // High stakes demand 1.0, so both drafts fell short; the second was the
    // bound, so it settled without a second question.
    expect(questions).toEqual(["Question 1: who reads the notes?"])
    expect(drafts.map((d) => d.banner)).toEqual([
      "Score: pending. Threshold: 1 (stakes: high).",
      "⚠ Score 0.90 < threshold 1 (stakes: high). Not yet ready by my judgment."
    ])
    expect(draft.scoreReason).toBe("draft 2")
    expect(draft.score).toBe(0.95)
  }), { timeout: 60_000 })

it.live("settles an overridden draft below the threshold without asking again", () =>
  Effect.gen(function*() {
    const { answer, drafts } = script([0.4, 0.5, 0.6])
    const questions: Array<string> = []
    const executionId = "extract-prompt-override"
    const draft = yield* Kit.run(ExtractPrompt, { maxTurns: 3 }, {
      filename: join(directory, "override.sqlite"),
      executionId,
      script: answer,
      // A second answer is ready, so a loop that kept going would be answered rather than park.
      actions: Layer.mergeAll(layer, person(executionId, ["ship it", "engineers"], questions))
    })

    expect(questions).toEqual(["Question 1: who reads the notes?"])
    expect(drafts).toHaveLength(2)
    expect(draft).toMatchObject({ scoreReason: "draft 2", score: 0.5, overridden: true, overrideReason: "ship it" })
  }), { timeout: 60_000 })

it.live("asks the person even when the first draft claims to be resolved", () =>
  Effect.gen(function*() {
    const { answer, drafts } = script([0.4, 0.9], { claimsResolved: true })
    const questions: Array<string> = []
    const executionId = "extract-prompt-unasked"
    const draft = yield* Kit.run(ExtractPrompt, {}, {
      filename: join(directory, "unasked.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(layer, person(executionId, ["engineers"], questions))
    })

    // Nobody had been asked yet, so the first draft's claim could not settle the flow.
    expect(questions).toEqual(["Question 1: who reads the notes?"])
    expect(drafts).toHaveLength(2)
    expect(draft.scoreReason).toBe("draft 2")
  }), { timeout: 60_000 })
