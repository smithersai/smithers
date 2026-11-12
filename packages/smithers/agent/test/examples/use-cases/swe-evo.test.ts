import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import {
  CaptureDiff,
  Implement,
  type Instance,
  layer,
  PrepareRepo,
  Refine,
  ScoreCandidate,
  scoreTimeoutS,
  SweEvo
} from "../../../examples/use-cases/swe-evo.ts"

const directory = mkdtempSync(join(tmpdir(), "swe-evo-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const instance: typeof Instance.Type = {
  instance_id: "iterative__dvc_1.6.3_1.6.4",
  repo: "iterative/dvc",
  base_commit: "abc123",
  image: "sweevo/dvc:1.6.3",
  problem_statement: "1.6.4: `dvc status` reports frozen stages.",
  start_version: "1.6.3",
  end_version: "1.6.4"
}

/**
 * A checkout the agents edit, a patch built from every file the agents said
 * they changed, and a scorer that resolves the instance when the patch touches
 * `dvc/repo/status.py`. Every host call and agent turn is recorded in order.
 */
const host = (calls: Array<string>, edited: Array<string>) =>
  Layer.mergeAll(
    PrepareRepo.toLayer(({ baseCommit, image, instanceId }) =>
      Effect.sync(() => {
        calls.push(`prepare ${instanceId} from ${image}`)
        return { workdir: `/work/${instanceId}`, baseCommit, headLine: `${baseCommit} release 1.6.3` }
      })
    ),
    CaptureDiff.toLayer(({ instanceId }) =>
      Effect.sync(() => {
        calls.push(`diff ${instanceId}`)
        const patch = edited.map((file) => `--- a/${file}\n+++ b/${file}\n`).join("")
        return { patch, changedFiles: edited.length, insertions: edited.length, deletions: 0 }
      })
    ),
    ScoreCandidate.toLayer(({ instanceId, patch, timeoutS }) =>
      Effect.sync(() => {
        calls.push(`score ${instanceId} in ${timeoutS}s`)
        const resolved = patch.includes("dvc/repo/status.py") ? 1 : 0
        return {
          instance_id: instanceId,
          repo: "iterative/dvc",
          image: "sweevo/dvc:1.6.3",
          log_parser: "parse_log_pytest",
          test_cmds: "pytest tests/func/test_status.py",
          resolved,
          fix_rate_pct: resolved * 100,
          f2p_total: 2,
          f2p_passed: resolved * 2,
          p2p_total: 3,
          p2p_passed: 3,
          all_p2p_pass: true,
          candidate_applied: patch.length > 0,
          testpatch_applied: true,
          timed_out: false,
          duration_s: 41,
          parsed_test_count: 5,
          f2p_status: { "tests/func/test_status.py::test_frozen": resolved === 1 ? "PASSED" : "FAILED" },
          p2p_failures: {}
        }
      })
    )
  )

/**
 * An implementer that answers off-schema on its first `implementFailures`
 * turns, and a refiner that adds the module behind the command the spec
 * names. Both derive the files they touch from the spec they were handed.
 */
const script = (calls: Array<string>, edited: Array<string>, implementFailures = 0) => {
  let implementTurns = 0
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are evolving the")) {
      implementTurns += 1
      calls.push("implement")
      if (implementTurns <= implementFailures) return { unexpected: true }
      // The draft only touches the CLI the release notes name.
      if (/`dvc status`/.test(asked)) edited.push("dvc/command/status.py")
      return { summary: "drafted the status change", filesChanged: ["dvc/command/status.py"] }
    }
    if (asked.includes("You are a senior reviewer completing")) {
      calls.push("refine")
      // The review completes the draft in the module behind the command.
      if (/RELEASE SPECIFICATION \(1\.6\.4\)/.test(asked)) edited.push("dvc/repo/status.py")
      return { summary: "completed frozen-stage handling", filesChanged: ["dvc/repo/status.py"] }
    }
    return undefined
  }
  return answer
}

it.effect("prepares, drafts, refines, diffs and scores the instance in order", () =>
  Effect.gen(function*() {
    const calls: Array<string> = []
    const edited: Array<string> = []
    const score = yield* Kit.run(SweEvo, instance, {
      filename: join(directory, "resolved.sqlite"),
      executionId: "swe-evo-resolved",
      script: script(calls, edited),
      actions: Layer.mergeAll(layer, host(calls, edited))
    })

    expect(calls).toEqual([
      "prepare iterative__dvc_1.6.3_1.6.4 from sweevo/dvc:1.6.3",
      "implement",
      "refine",
      "diff iterative__dvc_1.6.3_1.6.4",
      `score iterative__dvc_1.6.3_1.6.4 in ${scoreTimeoutS}s`
    ])
    // The scorer read the patch the diff captured from both agents' edits.
    expect(score.resolved).toBe(1)
    expect(score.candidate_applied).toBe(true)
    expect(score.f2p_status).toEqual({ "tests/func/test_status.py::test_frozen": "PASSED" })
  }))

it.effect("retries a failed draft once and still scores the instance", () =>
  Effect.gen(function*() {
    const calls: Array<string> = []
    const edited: Array<string> = []
    // Two off-schema answers spend the first attempt and its one correction.
    const score = yield* Kit.run(SweEvo, instance, {
      filename: join(directory, "retried.sqlite"),
      executionId: "swe-evo-retried",
      script: script(calls, edited, 2),
      actions: Layer.mergeAll(layer, host(calls, edited))
    })

    expect(calls.filter((call) => call === "implement")).toHaveLength(3)
    expect(calls.slice(-3)).toEqual([
      "refine",
      "diff iterative__dvc_1.6.3_1.6.4",
      `score iterative__dvc_1.6.3_1.6.4 in ${scoreTimeoutS}s`
    ])
    expect(score.resolved).toBe(1)
  }))

it.effect("fails the run when the draft fails twice, before anything is scored", () =>
  Effect.gen(function*() {
    const calls: Array<string> = []
    const edited: Array<string> = []
    const exit = yield* Effect.exit(Kit.run(SweEvo, instance, {
      filename: join(directory, "exhausted.sqlite"),
      executionId: "swe-evo-exhausted",
      script: script(calls, edited, 99),
      actions: Layer.mergeAll(layer, host(calls, edited))
    }))

    expect(exit._tag).toBe("Failure")
    expect(calls).toContain("implement")
    expect(calls).not.toContain("refine")
    expect(calls.some((call) => call.startsWith("score"))).toBe(false)
  }))

it.effect("does not retry a draft whose seat has no model, since a second call fails the same way", () =>
  Effect.gen(function*() {
    const calls: Array<string> = []
    const edited: Array<string> = []
    const seats: Array<string> = []
    const error = yield* Effect.flip(Kit.run(SweEvo, instance, {
      filename: join(directory, "unresolved.sqlite"),
      executionId: "swe-evo-unresolved",
      script: script(calls, edited),
      actions: Layer.mergeAll(
        Implement.layer.pipe(Layer.provide(Kit.refusingSeats(seats))),
        Refine.layer,
        host(calls, edited)
      )
    }))

    // One draft attempt asked for its seat once; 0.x's retry did not run it again.
    expect(seats).toEqual(["anthropic:claude-sonnet-5-5"])
    expect(error._tag).toBe("@smthrs/agent/Seat/SeatUnresolved")
    expect(calls).toEqual(["prepare iterative__dvc_1.6.3_1.6.4 from sweevo/dvc:1.6.3"])
  }))
