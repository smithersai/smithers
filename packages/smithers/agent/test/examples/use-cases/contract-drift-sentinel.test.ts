import { afterAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContractDriftSentinel, layer, statusOf } from "../../../examples/use-cases/contract-drift-sentinel.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "contract-drift-sentinel-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

/** The contract files the loader "reads": each is a comma-separated list of response fields. */
const files: Record<string, string> = {
  "v1.yaml": "id,name,email,phone",
  "v2.yaml": "id,name",
  "v2-additive.yaml": "id,name,email,phone,avatar"
}

/**
 * A loader that reads `files`, a diff engine that reports every field the
 * current revision dropped or added, an analyst that scores 35 per removal
 * and blames every consumer it is handed, and an output step that writes the
 * status it is handed. Each request is recorded in order.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a schema loader")) {
      const baseline = files[field(asked, "Baseline path")]!
      const current = files[field(asked, "Current path")]!
      turns.push(`load as ${/\(format: (\S+)\)/.exec(asked)?.[1]}`)
      return { format: "openapi", version: "3.1.0", baseline, current, entities: ["GET /users/{id}"] }
    }
    if (asked.includes("You are a contract diff engine")) {
      const before: ReadonlyArray<string> = JSON.parse(field(asked, "Baseline")).split(",")
      const after: ReadonlyArray<string> = JSON.parse(field(asked, "Current")).split(",")
      turns.push("diff")
      const removed = before.filter((name) => !after.includes(name))
      const added = after.filter((name) => !before.includes(name))
      return {
        additions: added.map((name) => ({ path: `response.body.${name}`, description: "new field" })),
        removals: removed.map((name) => ({ path: `response.body.${name}`, description: "field dropped" })),
        modifications: [],
        breakingCandidates: removed.map((name) => `response.body.${name}`),
        totalChanges: removed.length + added.length
      }
    }
    if (asked.includes("You are a contract compatibility analyst")) {
      const consumers: ReadonlyArray<string> = JSON.parse(field(asked, "Consumers"))
      const diff = JSON.parse(field(asked, "Diff"))
      turns.push(`analyze for ${consumers.join(",") || "no consumers"}`)
      return {
        breakingChanges: diff.removals.map((removal: { readonly path: string }) => ({
          path: removal.path,
          severity: "high",
          reason: "consumers read it",
          affectedConsumers: consumers,
          migrationHint: "keep the field until consumers move"
        })),
        safeChanges: diff.additions.map((addition: { readonly path: string }) => ({
          path: addition.path,
          kind: "addition"
        })),
        riskScore: Math.min(100, 35 * diff.removals.length),
        summary: `${diff.removals.length} removals, ${diff.additions.length} additions`
      }
    }
    if (asked.includes("Write the PR comment and status for this contract change")) {
      const status = field(asked, "Status")
      const count = Number(field(asked, "Breaking count"))
      turns.push(`output ${status}`)
      return {
        status,
        prComment: `${count} breaking changes: ${
          JSON.parse(field(asked, "Breaking changes")).map((c: { readonly path: string }) => c.path).join(", ")
        }`,
        breakingCount: count,
        riskScore: Number(field(asked, "Risk score")),
        summary: field(asked, "Summary")
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("blocks a change whose removals score 70", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      ContractDriftSentinel,
      { baselinePath: "v1.yaml", currentPath: "v2.yaml", format: "openapi", consumers: ["mobile", "billing"] },
      {
        filename: join(directory, "block.sqlite"),
        executionId: "contract-drift-block",
        script: answer,
        actions: layer
      }
    )

    expect(turns).toEqual(["load as openapi", "diff", "analyze for mobile,billing", "output block"])
    expect(output).toEqual({
      status: "block",
      prComment: "2 breaking changes: response.body.email, response.body.phone",
      breakingCount: 2,
      riskScore: 70,
      summary: "2 removals, 0 additions"
    })
  }))

it.effect("approves an additive change, auto-detecting the format with no consumers", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(ContractDriftSentinel, { baselinePath: "v1.yaml", currentPath: "v2-additive.yaml" }, {
      filename: join(directory, "approve.sqlite"),
      executionId: "contract-drift-approve",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["load as auto", "diff", "analyze for no consumers", "output approve"])
    expect(output.breakingCount).toBe(0)
    expect(output.summary).toBe("0 removals, 1 additions")
  }))

describe("statusOf", () => {
  it("blocks from 70, warns from 30, and approves below", () => {
    expect([100, 70, 69, 30, 29, 0].map(statusOf)).toEqual(["block", "block", "warn", "warn", "approve", "approve"])
  })
})
