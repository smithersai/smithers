import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigDiffExplainer, layer } from "../../../examples/use-cases/config-diff-explainer.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "config-diff-explainer-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

const risks = ["low", "medium", "high", "critical"]

/**
 * A fetcher that returns one diff per path it is handed, an explainer that
 * rates Terraform changes high and everything else low, and a reviewer that
 * approves when the risk is at or under the threshold it is handed. Each
 * request is recorded in order. With `brokenExplainer` the explainer answers
 * off-schema.
 */
const script = (brokenExplainer = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a config diff fetcher")) {
      const range = /Collect the config diffs for (\S+)\./.exec(asked)?.[1]
      const paths: ReadonlyArray<string> = JSON.parse(field(asked, "Paths"))
      turns.push(`fetch ${range} ${field(asked, "File patterns")}`)
      return {
        files: paths.map((path) => ({
          path,
          kind: path.endsWith(".tf") ? "terraform" : "helm",
          diff: "-replicas: 3\n+replicas: 1",
          service: path.split("/")[0]
        })),
        totalChanges: paths.length,
        summary: `${paths.length} files`
      }
    }
    if (asked.includes("You are a config change analyst")) {
      const files: ReadonlyArray<{ readonly kind: string; readonly service: string }> = JSON.parse(
        field(asked, "Files")
      )
      turns.push(`explain ${files.length} with context ${field(asked, "Context")}`)
      if (brokenExplainer) return { unexpected: true }
      const blastRadius = files.map((file) => ({
        system: file.service,
        impact: `${file.kind} change`,
        severity: file.kind === "terraform" ? "high" : "low"
      }))
      return {
        blastRadius,
        riskLevel: blastRadius.some((b) => b.severity === "high") ? "high" : "low",
        affectedSystems: blastRadius.map((b) => b.system),
        rollbackNotes: "revert the commit",
        summary: `${files.length} systems touched`
      }
    }
    if (asked.includes("Review this config change")) {
      const risk = field(asked, "Risk level")
      const threshold = field(asked, "Auto-approve threshold")
      turns.push(`review ${risk} against ${threshold}`)
      const approve = risks.indexOf(risk) <= risks.indexOf(threshold)
      return {
        action: approve ? "approve" : "request-changes",
        comment: `affects ${JSON.parse(field(asked, "Affected systems")).join(", ")}`,
        summary: field(asked, "Summary")
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("explains the blast radius and requests changes above the threshold", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(
      ConfigDiffExplainer,
      {
        paths: ["checkout/values.yaml", "network/main.tf"],
        gitRef: "main..release",
        context: "Friday deploy",
        autoApproveThreshold: "medium"
      },
      {
        filename: join(directory, "request-changes.sqlite"),
        executionId: "config-diff-request-changes",
        script: answer,
        actions: layer
      }
    )

    expect(turns).toEqual([
      `fetch main..release ["values.yaml","*.tf","*.env","*.yaml"]`,
      "explain 2 with context Friday deploy",
      "review high against medium"
    ])
    expect(output.explanation.affectedSystems).toEqual(["checkout", "network"])
    expect(output.explanation.riskLevel).toBe("high")
    expect(output.review).toEqual({
      action: "request-changes",
      comment: "affects checkout, network",
      summary: "2 systems touched"
    })
  }))

it.effect("reviews the last commit against a low threshold when nothing is given", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(ConfigDiffExplainer, {}, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "config-diff-defaults",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      `fetch HEAD~1..HEAD ["values.yaml","*.tf","*.env","*.yaml"]`,
      "explain 0 with context ",
      "review low against low"
    ])
    expect(output.review.action).toBe("approve")
  }))

it.effect("fails without a review when the explanation fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(ConfigDiffExplainer, { paths: ["api/values.yaml"] }, {
      filename: join(directory, "failed.sqlite"),
      executionId: "config-diff-failed",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("explain 1 with context ")
    expect(turns.some((turn) => turn.startsWith("review"))).toBe(false)
  }))
