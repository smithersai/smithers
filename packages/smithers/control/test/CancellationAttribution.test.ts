/**
 * `Cancellation.attribute` against an independent oracle.
 *
 * The fold is the only thing that turns an anonymous `cancel_requested_at_ms`
 * column into "who cancelled this run and why", and it is a graph walk: the
 * example-based tests beside it cover the shapes somebody thought of. This one
 * generates ancestry forests and checks the answer against a second
 * implementation written from the module's stated contract rather than from its
 * code, so a rewrite of the walk that changes an edge case is caught.
 *
 * `fast-check` is not a dependency of this repository, so the generator is a
 * seeded mulberry32: the same 300 cases run on every machine and a red run is
 * reproducible from the printed case.
 */
import { describe, expect, it } from "vitest"
import * as Cancellation from "../src/Cancellation.ts"
import type { Cancellation as CancellationSummary, Principal } from "../src/ControlSchema.vibe"

/** Deterministic PRNG. A fixed seed keeps a failure reproducible. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * The contract, restated: a run's own attributed request wins; otherwise the
 * nearest ancestor cancelled no later than the run makes it a cascade, carrying the principal and
 * reason of the nearest cancelled ancestor that carries a request at all;
 * otherwise the engine cancelled it on its own account.
 *
 * Written as "collect the chain, then classify" so it is not a transcription of
 * the production walk.
 */
const oracle = (input: Cancellation.Input): Map<string, CancellationSummary> => {
  const byId = new Map(input.runs.map((run) => [run.runId, run]))
  const isCancelled = (evidence: Cancellation.Evidence): boolean =>
    evidence.cancelRequestedAt !== undefined || evidence.cancelledAt !== undefined ||
    input.requests.has(evidence.runId)

  /** The ancestor ids above a run, nearest first, stopping at a repeat or a gap. */
  const chain = (run: Cancellation.Evidence): Array<string> => {
    const ids: Array<string> = []
    const seen = new Set<string>([run.runId])
    let current = run.parentRunId
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      const ancestor = byId.get(current)
      if (ancestor === undefined) break
      ids.push(current)
      current = ancestor.parentRunId
    }
    return ids
  }

  const answers = new Map<string, CancellationSummary>()
  for (const run of input.runs) {
    if (!isCancelled(run)) continue
    const own = input.requests.get(run.runId)
    const requestedAt = own?.requestedAt ?? run.cancelRequestedAt ?? run.cancelledAt ?? 0
    if (own !== undefined) {
      answers.set(run.runId, {
        requestedAt,
        source: "control",
        ...(own.principal === undefined ? {} : { principal: own.principal }),
        ...(own.reason === undefined ? {} : { reason: own.reason })
      })
      continue
    }
    const firstEvidenceAt = (id: string) => {
      const row = byId.get(id)!
      return Math.min(
        input.requests.get(id)?.requestedAt ?? Infinity,
        row.cancelRequestedAt ?? Infinity,
        row.cancelledAt ?? Infinity
      )
    }
    let deadline = firstEvidenceAt(run.runId)
    const causalDeadlines = new Map<string, number>()
    const cancelledAncestors = chain(run).filter((id) => {
      if (firstEvidenceAt(id) > deadline) return false
      causalDeadlines.set(id, deadline)
      deadline = firstEvidenceAt(id)
      return true
    })
    const nearest = cancelledAncestors[0]
    if (nearest === undefined) {
      answers.set(run.runId, { requestedAt, source: "engine" })
      continue
    }
    const origin = cancelledAncestors.map((id) => {
      const request = input.requests.get(id)
      return request !== undefined && request.requestedAt <= causalDeadlines.get(id)! ? request : undefined
    }).find((request) => request !== undefined)
    answers.set(run.runId, {
      requestedAt,
      source: "cascade",
      ...(origin?.principal === undefined ? {} : { principal: origin.principal }),
      ...(origin?.reason === undefined ? {} : { reason: origin.reason }),
      cascadedFrom: nearest
    })
  }
  return answers
}

// `stampedAt` is part of every stamped principal, so the generated evidence
// carries one. It is derived from the index rather than the clock: a property
// case has to be reproducible from its printed rendering.
const principal = (index: number): Principal => ({
  id: `operator-${index}`,
  kind: "user",
  stampedAt: 1_700_000_000_000 + index
})

/** A forest of at most `size` runs, each with at most one parent already generated. */
const generate = (random: () => number): Cancellation.Input => {
  const size = 1 + Math.floor(random() * 12)
  const runs: Array<Cancellation.Evidence> = []
  const requests = new Map<string, Cancellation.Request>()
  for (let index = 0; index < size; index++) {
    const runId = `run-${index}`
    // A parent is any earlier run, so the ancestry is a forest of depth <= size.
    const parentRoll = random()
    const parentRunId = index > 0 && parentRoll < 0.75
      ? `run-${Math.floor(random() * index)}`
      : undefined
    const evidence: Cancellation.Evidence = {
      runId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(random() < 0.3 ? { cancelRequestedAt: 1_000 + index } : {}),
      ...(random() < 0.3 ? { cancelledAt: 2_000 + index } : {})
    }
    runs.push(evidence)
    if (random() < 0.3) {
      requests.set(runId, {
        requestedAt: 3_000 + index,
        ...(random() < 0.7 ? { principal: principal(index) } : {}),
        ...(random() < 0.7 ? { reason: `reason-${index}` } : {})
      })
    }
  }
  return { runs, requests }
}

describe("Cancellation.attribute matches an independent oracle", () => {
  it("agrees on 300 generated ancestry forests", () => {
    const random = mulberry32(0x5eed_1234)
    for (let round = 0; round < 300; round++) {
      const input = generate(random)
      const actual = Cancellation.attribute(input)
      const expected = oracle(input)
      const rendered = () => JSON.stringify({ runs: input.runs, requests: [...input.requests] }, undefined, 1)
      // Compare as sorted entries so a failure prints the case, not a Map.
      const normalize = (value: ReadonlyMap<string, CancellationSummary>) =>
        [...value.entries()].sort(([left], [right]) => left.localeCompare(right))
      if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
        throw new Error(
          `round ${round} disagreed\ncase: ${rendered()}\nactual: ${JSON.stringify(normalize(actual))}\n` +
            `oracle: ${JSON.stringify(normalize(expected))}`
        )
      }
    }
  })

  it.each(["request", "column", "interruption"] as const)(
    "does not attribute an earlier engine cancellation to a later ancestor %s",
    (source) => {
      const parent = {
        runId: "parent",
        ...(source === "column" ? { cancelRequestedAt: 20 } : {}),
        ...(source === "interruption" ? { cancelledAt: 20 } : {})
      }
      const child = { runId: "child", parentRunId: "parent", cancelledAt: 10 }
      const before = Cancellation.attribute({ runs: [child, { runId: "parent" }], requests: new Map() })
      const after = Cancellation.attribute({
        runs: [child, parent],
        requests: new Map(
          source === "request" ?
            [["parent", {
              requestedAt: 20,
              principal: principal(1),
              reason: "later"
            }]] :
            []
        )
      })
      expect(after.get("child")).toEqual(before.get("child"))
      expect(after.get("child")).toEqual({ source: "engine", requestedAt: 10 })
    }
  )

  it("keeps attribution when the engine request column precedes the control journal", () => {
    const answers = Cancellation.attribute({
      runs: [
        { runId: "parent", cancelRequestedAt: 10 },
        { runId: "child", parentRunId: "parent", cancelledAt: 12 }
      ],
      requests: new Map([["parent", { requestedAt: 11, principal: principal(1), reason: "budget" }]])
    })
    expect(answers.get("child")).toEqual({
      source: "cascade",
      requestedAt: 12,
      cascadedFrom: "parent",
      principal: principal(1),
      reason: "budget"
    })
  })

  it("does not borrow a later root request through an earlier cancelled parent", () => {
    const answers = Cancellation.attribute({
      runs: [
        { runId: "root" },
        { runId: "parent", parentRunId: "root", cancelledAt: 10 },
        { runId: "child", parentRunId: "parent", cancelledAt: 15 }
      ],
      requests: new Map([["root", { requestedAt: 20, principal: principal(1), reason: "later" }]])
    })
    expect(answers.get("child")).toEqual({ source: "cascade", requestedAt: 15, cascadedFrom: "parent" })
  })

  it("survives a cyclic parent chain without hanging", () => {
    const answers = Cancellation.attribute({
      runs: [
        { runId: "a", parentRunId: "b", cancelRequestedAt: 1 },
        { runId: "b", parentRunId: "a" }
      ],
      requests: new Map()
    })
    expect(answers.get("a")).toEqual({ requestedAt: 1, source: "engine" })
    expect(answers.has("b")).toBe(false)
  })

  it("stops the ancestor walk at a parent the evidence does not contain", () => {
    // A listing scoped to one run reads only that run's chain, and retention
    // can delete a row mid-chain. A missing ancestor ends the walk; it must not
    // be read as a cancelled one.
    const answers = Cancellation.attribute({
      runs: [{ runId: "child", parentRunId: "gone", cancelledAt: 5 }],
      requests: new Map()
    })
    expect(answers.get("child")).toEqual({ requestedAt: 5, source: "engine" })
  })

  it("attributes a grandchild to the operator who cancelled the grandparent", () => {
    const answers = Cancellation.attribute({
      runs: [
        { runId: "root", cancelRequestedAt: 10 },
        { runId: "child", parentRunId: "root", cancelRequestedAt: 11 },
        { runId: "grandchild", parentRunId: "child", cancelledAt: 12 }
      ],
      requests: new Map([[
        "root",
        { requestedAt: 9, principal: principal(1), reason: "budget" }
      ]])
    })
    expect(answers.get("grandchild")).toEqual({
      requestedAt: 12,
      source: "cascade",
      principal: principal(1),
      reason: "budget",
      cascadedFrom: "child"
    })
  })
})
