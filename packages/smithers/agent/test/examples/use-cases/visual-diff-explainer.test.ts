import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, VisualDiffExplainer } from "../../../examples/use-cases/visual-diff-explainer.vibe"

const directory = mkdtempSync(join(tmpdir(), "visual-diff-explainer-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A runner that fails the tests named in `failing`, a collector that encodes
 * each test it is handed, an analyst that calls a large diff a critical layout
 * shift and a small one a cosmetic color change, and a reporter that counts the
 * findings it is handed. Each request is recorded in order.
 */
const script = (failing: ReadonlyArray<readonly [name: string, diffPercentage: number]>) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const run = /Command: (.+)\nBaseline directory: (.+)\nCurrent directory: (.+)/.exec(asked)
    if (run !== null) {
      turns.push(`run ${run[1]} over ${run[2]} and ${run[3]}`)
      return {
        tests: failing.map(([name, diffPercentage]) => ({
          name,
          suite: "home",
          baselinePath: `${run[2]}/${name}.png`,
          currentPath: `${run[3]}/${name}.png`,
          diffPercentage
        })),
        totalFailed: failing.length,
        runner: "playwright"
      }
    }
    const collect = /Collect the screenshot pairs for (\d+) failed tests\.\n\nTests: (.+)/.exec(asked)
    if (collect !== null) {
      const tests: ReadonlyArray<{ name: string; baselinePath: string; currentPath: string; diffPercentage: number }> =
        JSON.parse(collect[2]!)
      turns.push(`collect ${collect[1]}: ${tests.map((t) => t.name).join(", ")}`)
      return {
        pairs: tests.map((t) => ({
          testName: t.name,
          suite: "home",
          baselineImage: Buffer.from(t.baselinePath).toString("base64"),
          currentImage: Buffer.from(t.currentPath).toString("base64"),
          diffPercentage: t.diffPercentage
        }))
      }
    }
    const analyze = /Explain what changed in each screenshot pair\.\n\nPairs: (.+)/.exec(asked)
    if (analyze !== null) {
      const pairs: ReadonlyArray<{ testName: string; baselineImage: string; diffPercentage: number }> = JSON.parse(
        analyze[1]!
      )
      turns.push(`analyze ${pairs.map((p) => Buffer.from(p.baselineImage, "base64").toString()).join(", ")}`)
      return {
        findings: pairs.map((p) => {
          const large = p.diffPercentage >= 10
          return {
            testName: p.testName,
            changedRegion: "hero banner",
            changeType: large ? "layout-shift" : "color-change",
            likelyCause: large ? "flex-wrap removed from .hero" : "--accent token changed",
            severity: large ? "critical" : "cosmetic",
            affectedComponents: ["Hero"],
            summary: `${p.testName} changed by ${p.diffPercentage}%`
          }
        })
      }
    }
    const report = /Repository: (.+)\nOutput file: (.+)\nFindings: (.+)/.exec(asked)
    if (report !== null) {
      const findings: ReadonlyArray<{ testName: string; changeType: string; severity: string; summary: string }> = JSON
        .parse(report[3]!)
      turns.push(`report ${findings.length} findings for ${report[1]} to ${report[2]}`)
      const critical = findings.filter((f) => f.severity === "critical").length
      return {
        title: `Visual regressions in ${report[1]}`,
        totalRegressions: findings.length,
        criticalCount: critical,
        findings: findings.map(({ changeType, severity, summary, testName }) => ({
          testName,
          changedRegion: "hero banner",
          changeType,
          likelyCause: "see analysis",
          severity,
          summary
        })),
        recommendation: critical > 0 ? "File issues for the critical regressions." : "Update the baselines.",
        markdown: findings.map((f) => `- ${f.severity}: ${f.summary}`).join("\n")
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("hands each failure's screenshots through to a ranked report", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([["hero", 18.5], ["footer", 0.4]])
    const report = yield* Kit.run(VisualDiffExplainer, { repository: "acme/web" }, {
      filename: join(directory, "regressions.sqlite"),
      executionId: "visual-diff-regressions",
      script: answer,
      actions: layer
    })

    // Defaults reach the runner; each later step saw what the step before it produced.
    expect(turns).toEqual([
      "run npx playwright test --reporter=json over __screenshots__/baseline and __screenshots__/current",
      "collect 2: hero, footer",
      "analyze __screenshots__/baseline/hero.png, __screenshots__/baseline/footer.png",
      "report 2 findings for acme/web to visual-regression-report.md"
    ])
    expect(report.totalRegressions).toBe(2)
    expect(report.criticalCount).toBe(1)
    expect(report.findings.map((f) => [f.testName, f.changeType])).toEqual([
      ["hero", "layout-shift"],
      ["footer", "color-change"]
    ])
    expect(report.recommendation).toBe("File issues for the critical regressions.")
    expect(report.markdown).toBe("- critical: hero changed by 18.5%\n- cosmetic: footer changed by 0.4%")
  }))

it.effect("still asks every step when no test failed", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([])
    const report = yield* Kit.run(VisualDiffExplainer, {
      testCommand: "pnpm test:visual",
      baselineDir: "snapshots/main",
      currentDir: "snapshots/pr",
      outputFile: "out/visual.md"
    }, {
      filename: join(directory, "clean.sqlite"),
      executionId: "visual-diff-clean",
      script: answer,
      actions: layer
    })

    // As in 0.x, nothing skips the empty case.
    expect(turns).toEqual([
      "run pnpm test:visual over snapshots/main and snapshots/pr",
      "collect 0: ",
      "analyze ",
      "report 0 findings for unknown to out/visual.md"
    ])
    expect(report.totalRegressions).toBe(0)
    expect(report.recommendation).toBe("Update the baselines.")
  }))
