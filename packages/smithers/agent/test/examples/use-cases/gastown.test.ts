import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Gastown,
  layer,
  patrolsFor,
  WriteBead,
  WriteConvoy,
  WriteMergeRequest
} from "../../../examples/use-cases/gastown.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "gastown-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A beads tracker that records every write in order, in one log shared with the agents. */
const tracker = (log: Array<string>) =>
  Layer.mergeAll(
    WriteConvoy.toLayer((convoy) =>
      Effect.sync(() => {
        log.push(
          `convoy ${convoy.status} ${convoy.id} [${
            convoy.trackedBeads.join(",")
          }] ${convoy.completedTasks}/${convoy.failedTasks}`
        )
        return convoy
      })
    ),
    WriteBead.toLayer((bead) =>
      Effect.sync(() => {
        log.push(`bead ${bead.id} ${bead.status} ${bead.assignee} ${bead.convoyId}`)
        return { ...bead, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" }
      })
    ),
    WriteMergeRequest.toLayer((request) =>
      Effect.sync(() => {
        log.push(`mr ${request.id} ${request.phase} ${request.branch} -> ${request.targetBranch}`)
        return request
      })
    )
  )

interface Town {
  /** Each bead the mayor plans and how its polecat ends: an exit type, or `broken` for off-schema answers. */
  readonly polecats: Readonly<Record<string, "completed" | "escalated" | "deferred" | "broken">>
  /** The phase the refinery reports per bead. */
  readonly merges?: Readonly<Record<string, "merged" | "rejected" | "failed" | "broken">>
  /** A priority every bead the mayor plans claims, in place of its position. */
  readonly priority?: number
}

/**
 * Agents that derive every answer from the prompt they were handed, recording
 * each request in the shared log. The report counts what its prompt shows.
 */
const script = (town: Town, log: Array<string>) => {
  const asked: { mayor?: string; report?: string } = {}
  const answer: Kit.Script = (text) => {
    if (text.includes("You are the Mayor")) {
      asked.mayor = text
      log.push("mayor")
      return {
        convoyId: "hq-cv-00001",
        beads: Object.keys(town.polecats).map((id, index) => ({
          id,
          title: `task ${id}`,
          description: `do ${id}`,
          files: [`src/${id}.ts`],
          priority: town.priority ?? index,
          acceptanceCriteria: "tests pass"
        }))
      }
    }
    const bead = /## Bead Assignment: (\S+)/.exec(text)?.[1]
    if (bead !== undefined) {
      log.push(`polecat ${bead}`)
      const outcome = town.polecats[bead]!
      if (outcome === "broken") return { unexpected: true }
      const files = /## Files to Focus On\n(.+)/.exec(text)?.[1] ?? ""
      return {
        beadId: bead,
        polecatName: bead,
        branch: `polecat/${bead}`,
        state: outcome === "completed" ? "done" : "stuck",
        summary: `worked ${bead}`,
        filesChanged: [files],
        commitCount: 2,
        exitType: outcome
      }
    }
    const completed = /### Completed: (\d+)\/(\d+)/.exec(text)
    if (completed !== null) {
      log.push(`witness ${completed[1]}/${completed[2]}`)
      return {
        type: "help",
        source: "witness",
        summary: `${completed[1]} of ${completed[2]} polecats reported`,
        severity: "high",
        suggestTo: "mayor",
        timestamp: "2026-10-14T00:00:00Z"
      }
    }
    const mr = /## Refinery: Process MR for (\S+)\n\n\*\*Branch:\*\* (\S+)\n\*\*Worker:\*\* \S+\n\*\*Target:\*\* (\S+)/
      .exec(
        text
      )
    if (mr !== null) {
      const [, id, branch, target] = mr
      log.push(`refinery ${id}`)
      const phase = town.merges?.[id!] ?? "merged"
      if (phase === "broken") return { unexpected: true }
      return {
        id: `mr-${id}`,
        branch,
        worker: id,
        issueId: id,
        targetBranch: target,
        phase,
        ...(phase === "rejected" ? { closeReason: "conflict", error: "rebase conflict" } : {}),
        ...(phase === "failed" ? { error: "push failed" } : {})
      }
    }
    if (text.includes("## Gas Town Convoy Report")) {
      asked.report = text
      log.push("report")
      const merges: ReadonlyArray<{ branch: string; phase: string }> = JSON.parse(
        /### Merge Queue Results\n(.+)/.exec(text)![1]!
      )
      const polecats: ReadonlyArray<{ exitType: string }> = JSON.parse(/### Polecat Results\n(.+)/.exec(text)![1]!)
      const settled = merges.filter((m) => m.phase !== "ready")
      const count = (phase: string) => settled.filter((m) => m.phase === phase).length
      return {
        convoyId: /\*\*Convoy:\*\* (\S+)/.exec(text)![1],
        totalBeads: [...text.matchAll(/\n- gt-\d+: /g)].length,
        merged: count("merged"),
        rejected: count("rejected"),
        failed: count("failed"),
        deferred: polecats.filter((p) => p.exitType === "deferred").length,
        summary: `witness events: ${JSON.parse(/### Witness Events\n(.+)/.exec(text)![1]!).length}`,
        mergeLog: settled.map((m) => ({ branch: m.branch, phase: m.phase, result: m.phase }))
      }
    }
    return undefined
  }
  return { answer, asked }
}

it.effect("plans, slings, works, merges serially, closes the convoy and reports", () =>
  Effect.gen(function*() {
    const log: Array<string> = []
    const { answer, asked } = script({
      polecats: { "gt-1": "completed", "gt-2": "completed", "gt-3": "escalated" },
      merges: { "gt-1": "merged", "gt-2": "rejected" }
    }, log)
    const report = yield* Kit.run(Gastown, { directory: ".", goal: "add retries" }, {
      filename: join(directory, "closed.sqlite"),
      executionId: "gastown-closed",
      script: answer,
      actions: Layer.mergeAll(layer, tracker(log))
    })

    expect(asked.mayor).toContain("Keep to 3-8 beads.")
    expect(log.slice(0, 2)).toEqual(["mayor", "convoy open hq-cv-00001 [gt-1,gt-2,gt-3] 0/0"])
    expect(log.slice(2, 5).sort()).toEqual([
      "bead gt-1 hooked gastown/polecats/gt-1 hq-cv-00001",
      "bead gt-2 hooked gastown/polecats/gt-2 hq-cv-00001",
      "bead gt-3 hooked gastown/polecats/gt-3 hq-cv-00001"
    ])
    expect(log.slice(5, 8).sort()).toEqual(["polecat gt-1", "polecat gt-2", "polecat gt-3"])
    // Every polecat reported, so the witness never patrolled; the escalated
    // bead never reached the queue, which landed the rest one at a time.
    expect(log.slice(8)).toEqual([
      "mr mr-gt-1 ready polecat/gt-1 -> main",
      "refinery gt-1",
      "mr mr-gt-2 ready polecat/gt-2 -> main",
      "refinery gt-2",
      "convoy closed hq-cv-00001 [gt-1,gt-2,gt-3] 1/1",
      "report"
    ])
    expect(report).toEqual({
      convoyId: "hq-cv-00001",
      totalBeads: 3,
      merged: 1,
      rejected: 1,
      failed: 0,
      deferred: 0,
      summary: "witness events: 0",
      mergeLog: [
        { branch: "polecat/gt-1", phase: "merged", result: "merged" },
        { branch: "polecat/gt-2", phase: "rejected", result: "rejected" }
      ]
    })
  }))

it.effect("patrols beads + 2 times when a polecat left no result, and keeps a failed merge's convoy open", () =>
  Effect.gen(function*() {
    const log: Array<string> = []
    const { answer } = script({
      polecats: { "gt-1": "completed", "gt-2": "broken", "gt-3": "deferred" },
      merges: { "gt-1": "failed" }
    }, log)
    const report = yield* Kit.run(Gastown, { directory: ".", goal: "add retries", baseBranch: "trunk" }, {
      filename: join(directory, "patrolled.sqlite"),
      executionId: "gastown-patrolled",
      script: answer,
      actions: Layer.mergeAll(layer, tracker(log))
    })

    // The broken polecat was asked again after its first attempt failed.
    expect(log.filter((entry) => entry === "polecat gt-2").length).toBeGreaterThanOrEqual(2)
    expect(log.filter((entry) => entry.startsWith("witness"))).toEqual(
      Array.from({ length: patrolsFor(3) }, () => "witness 2/3")
    )
    // A merge that settled `failed` is neither merged nor rejected, so the convoy stays open.
    expect(log.slice(log.indexOf("mr mr-gt-1 ready polecat/gt-1 -> trunk"))).toEqual([
      "mr mr-gt-1 ready polecat/gt-1 -> trunk",
      "refinery gt-1",
      "report"
    ])
    expect(report.failed).toBe(1)
    expect(report.deferred).toBe(1)
    expect(report.summary).toBe(`witness events: ${patrolsFor(3)}`)
  }))

it.effect("skips the refinery and the convoy close when no polecat completed", () =>
  Effect.gen(function*() {
    const log: Array<string> = []
    const { answer, asked } = script({ polecats: { "gt-1": "escalated" } }, log)
    const report = yield* Kit.run(Gastown, { directory: ".", goal: "add retries", maxAgents: 1 }, {
      filename: join(directory, "none-completed.sqlite"),
      executionId: "gastown-none-completed",
      script: answer,
      actions: Layer.mergeAll(layer, tracker(log))
    })

    expect(asked.mayor).toContain("Target 1 beads max for parallel execution.")
    expect(log).toEqual([
      "mayor",
      "convoy open hq-cv-00001 [gt-1] 0/0",
      "bead gt-1 hooked gastown/polecats/gt-1 hq-cv-00001",
      "polecat gt-1",
      "report"
    ])
    expect(report.mergeLog).toEqual([])
    expect(report.totalBeads).toBe(1)
  }))

it.effect("fails the run on a merge that fails twice, before anything behind it lands", () =>
  Effect.gen(function*() {
    const log: Array<string> = []
    const { answer } = script({
      polecats: { "gt-1": "completed", "gt-2": "completed" },
      merges: { "gt-1": "broken" }
    }, log)
    const exit = yield* Effect.exit(Kit.run(Gastown, { directory: ".", goal: "add retries" }, {
      filename: join(directory, "halted.sqlite"),
      executionId: "gastown-halted",
      script: answer,
      actions: Layer.mergeAll(layer, tracker(log))
    }))

    expect(exit._tag).toBe("Failure")
    expect(log).toContain("refinery gt-1")
    expect(log.some((entry) => entry.includes("gt-2") && (entry.startsWith("mr") || entry.startsWith("refinery"))))
      .toBe(
        false
      )
    expect(log).not.toContain("report")
  }))

it.effect("fails the plan as the mayor's answer when a bead's priority is outside P0-P4", () =>
  Effect.gen(function*() {
    const log: Array<string> = []
    const { answer } = script({ polecats: { "gt-1": "completed" }, priority: 5 }, log)
    const failure = yield* Effect.flip(Kit.run(Gastown, { directory: ".", goal: "add retries" }, {
      filename: join(directory, "out-of-range.sqlite"),
      executionId: "gastown-out-of-range",
      script: answer,
      actions: Layer.mergeAll(layer, tracker(log))
    }))

    // A typed agent failure at the mayor, not a defect at the tracker write.
    expect(failure._tag).toMatch(/StructuredOutputFailure$/)
    expect(log.every((entry) => entry === "mayor")).toBe(true)
  }))
