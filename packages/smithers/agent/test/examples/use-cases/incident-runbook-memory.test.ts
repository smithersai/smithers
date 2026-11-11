import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { TestNodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  approvalTask,
  IncidentRunbookMemory,
  layer,
  namespace
} from "../../../examples/use-cases/incident-runbook-memory.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "incident-runbook-memory-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The numbered items under `heading` in a prompt, up to the next blank line. */
const listed = (asked: string, heading: string): ReadonlyArray<string> => {
  const block = asked.slice(asked.indexOf(heading) + heading.length).split("\n\n")[0] ?? ""
  return [...block.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]!)
}

/**
 * A triager that reports what it was handed, a banker that writes one lesson
 * per incident, a distiller whose rule counts the lessons it was handed, and a
 * person who answers `decision`. Every request is recorded in order.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are an on-call triage assistant.")) {
      const lessons = listed(asked, "Lessons from past incidents on this topic:\n")
      const rules = listed(asked, "The team's ratified runbook rules:\n")
      const onCall = /Current on-call: (.+)/.exec(asked)![1]
      turns.push(`triage on-call ${onCall}, ${rules.length} rules, ${lessons.length} lessons`)
      return {
        diagnosis: asked.includes("(none yet — this is a cold start)") ? "cold start" : `seen ${lessons.length} times`,
        actions: ["Warm the cache tier"],
        groundedInPriorKnowledge: lessons.length + rules.length > 0
      }
    }
    if (asked.includes("You extract durable operational lessons from incidents.")) {
      const incident = /Incident just triaged: (.+)/.exec(asked)![1]!
      turns.push("bank")
      return { lessons: [`Warm the cache tier before deploys after ${incident}`], summary: "one lesson" }
    }
    if (asked.includes("You distill repeated operational lessons")) {
      const lessons = listed(asked, "accumulated these lessons on \"deploys\":\n\n")
      turns.push(`distill ${lessons.length}`)
      return {
        rule: `Warm the cache tier before deploys (${lessons.length} incidents)`,
        rationale: "it keeps recurring"
      }
    }
    return undefined
  }
  return { answer, turns }
}

/** Answers the real durable question once the engine parks on it. */
const approver = (executionId: string, decision: "approve" | "deny", turns: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(Effect.orDie(Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting(executionId).pipe(Effect.repeat({
      until: (waiting) => Option.isSome(waiting) && waiting.value.reason === "approval" && waiting.value.token !== null,
      schedule: Schedule.spaced(10)
    }))
    const { request, token } = Option.getOrThrow(row)
    const { name, kind, prompt } = request as { readonly name: string; readonly kind: string; readonly prompt: string }
    expect(name).toBe(approvalTask)
    expect(kind).toBe("json")
    turns.push(`approve ${prompt}`)
    yield* HumanTask.answer({
      token: DurableDeferred.Token.make(token ?? ""),
      value: { approved: decision === "approve", note: "too broad" }
    })
  }))))

/** Records the on-call fact the recall reads, as an operator would. */
const seedOnCall = (filename: string, onCall: string) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "on-call", value: onCall, provenance: {} })
    }).pipe(
      Effect.provide(
        Layer.orDie(MemoryStore.layer).pipe(Layer.provideMerge(TestNodeRuntime.durableEngine(filename, "seed")))
      )
    )
  )

it.live("banks a lesson per incident and ratifies a rule once three have piled up", () =>
  Effect.gen(function*() {
    const filename = join(directory, "ratified.sqlite")
    yield* seedOnCall(filename, "ada")
    const { answer, turns } = script()
    const run = (n: number) =>
      Kit.run(IncidentRunbookMemory, { incident: `scale-down ${n}`, topic: "deploys" }, {
        filename,
        executionId: `irm-${n}`,
        script: answer,
        actions: Layer.mergeAll(layer, approver(`irm-${n}`, "approve", turns))
      })

    const first = yield* run(1)
    expect(first.triage.diagnosis).toBe("cold start")
    expect(first.bank.lessonIds).toEqual(["lesson/irm-1/0"])
    yield* run(2)
    const third = yield* run(3)
    // Two lessons recalled is under the threshold: no distill yet.
    expect(third.recall.lessonCount).toBe(2)
    expect(third.proposal).toBeNull()

    turns.length = 0
    const fourth = yield* run(4)
    expect(turns).toEqual([
      "triage on-call ada, 0 rules, 3 lessons",
      "bank",
      "distill 3",
      "approve Ratify the distilled runbook rule\n\nrule/irm-4"
    ])
    expect([...fourth.recall.lessonIds].sort()).toEqual(["lesson/irm-1/0", "lesson/irm-2/0", "lesson/irm-3/0"])
    expect(fourth.proposal).toEqual({ ruleNoteId: "rule/irm-4", rationale: "it keeps recurring" })
    expect(fourth.ratification).toEqual({ ratifiedNoteId: "rule/irm-4", supersededCount: 3 })

    // The rule is live and the lessons it replaced dropped out; the fourth
    // incident's own lesson was banked after the recall, so it stays.
    turns.length = 0
    const fifth = yield* run(5)
    expect(turns[0]).toBe("triage on-call ada, 1 rules, 1 lessons")
    expect(fifth.recall).toEqual({
      rules: ["Warm the cache tier before deploys (3 incidents)"],
      lessons: ["Warm the cache tier before deploys after scale-down 4"],
      lessonIds: ["lesson/irm-4/0"],
      onCall: "ada",
      lessonCount: 1
    })
    expect(fifth.proposal).toBeNull()
  }), { timeout: 60_000 })

it.live("leaves the lessons live when a person rejects the rule", () =>
  Effect.gen(function*() {
    const filename = join(directory, "denied.sqlite")
    const { answer, turns } = script()
    const run = (n: number) =>
      Kit.run(IncidentRunbookMemory, { incident: `scale-down ${n}` }, {
        filename,
        executionId: `irm-denied-${n}`,
        script: answer,
        actions: Layer.mergeAll(layer, approver(`irm-denied-${n}`, "deny", turns))
      })

    for (const n of [1, 2, 3]) yield* run(n)
    const failure = yield* Effect.flip(run(4))
    expect(turns).toContain("distill 3")
    expect(failure).toMatchObject({ _tag: "examples/IncidentRunbookMemory/RuleDenied", note: "too broad" })

    // A pending rule hides nothing: inspect the real store after the denied run.
    const knowledge = yield* Effect.scoped(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        return {
          rules: yield* store.listNotes({ namespace, prefix: "rule/" }),
          lessons: yield* store.listNotes({ namespace, prefix: "lesson/" })
        }
      }).pipe(Effect.provide(
        Layer.orDie(MemoryStore.layer).pipe(Layer.provideMerge(TestNodeRuntime.durableEngine(filename, "inspect")))
      ))
    )
    expect(knowledge.rules).toEqual([])
    expect(knowledge.lessons).toHaveLength(4)
  }), { timeout: 60_000 })
