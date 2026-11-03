import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BranchDoctor, Execute, layer } from "../../../examples/use-cases/branch-doctor.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "branch-doctor-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const line = (asked: string, label: string) => JSON.parse(new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!)

/**
 * An inspector that finds one half-applied cherry-pick, a diagnosis derived
 * from that inspection, a plan derived from the diagnosis (one safe command,
 * one unsafe), and an execute step whose commands all exit with `exit`. Every
 * request is recorded in order.
 */
const script = (exit = 0) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a git inspector")) {
      const base = /\nBase branch: (.+)/.exec(asked)![1]
      turns.push(`inspect against ${base}, symptoms ${JSON.stringify(line(asked, "Symptoms"))}`)
      return {
        branch: "feature/login",
        conflictedFiles: ["src/auth.ts"],
        divergedCommits: 3,
        unresolvedCherryPicks: ["abc123"],
        staleGeneratedFiles: [],
        statusSummary: "cherry-pick in progress"
      }
    }
    if (asked.includes("You are a git diagnosis expert")) {
      const inspection = line(asked, "Inspection")
      turns.push(`diagnose ${inspection.branch}`)
      return {
        rootCause: inspection.unresolvedCherryPicks.length > 0 ? "partial-cherry-pick" : "unknown",
        details: `cherry-pick ${inspection.unresolvedCherryPicks[0]} stopped on a conflict`,
        severity: "medium",
        affectedPaths: inspection.conflictedFiles
      }
    }
    if (asked.includes("You are a git recovery planner")) {
      const diagnosis = line(asked, "Diagnosis")
      const inspection = line(asked, "Inspection")
      turns.push(`plan for ${diagnosis.rootCause}`)
      return {
        commands: [
          { command: "git cherry-pick --abort", purpose: "leave the half-applied pick", safe: true },
          { command: "git reset --hard ORIG_HEAD", purpose: "drop the partial result", safe: false }
        ],
        estimatedRisk: "low",
        manualStepsRequired: [`re-apply ${inspection.unresolvedCherryPicks[0]} by hand`]
      }
    }
    return undefined
  }
  // The deterministic execute step: no shell, each command exits with `exit`.
  const executor = Execute.toLayer(({ commands, repoPath }) =>
    Effect.sync(() => {
      turns.push(`execute in ${repoPath}: ${commands.join(", ")}`)
      return commands.map((command) => ({ command, exitCode: exit, output: "" }))
    })
  )
  return { answer, turns, actions: Layer.mergeAll(layer, executor) }
}

it.effect("proposes the recovery without running anything by default", () =>
  Effect.gen(function*() {
    const { actions, answer, turns } = script()
    const output = yield* Kit.run(BranchDoctor, { repoPath: "/repo", symptoms: ["push rejected"] }, {
      filename: join(directory, "dry-run.sqlite"),
      executionId: "branch-doctor-dry-run",
      script: answer,
      actions
    })

    // Inspect, diagnose and plan ran in order against the default base branch;
    // no executor was asked.
    expect(turns).toEqual([
      "inspect against main, symptoms [\"push rejected\"]",
      "diagnose feature/login",
      "plan for partial-cherry-pick"
    ])
    expect(output).toEqual({
      rootCause: "partial-cherry-pick",
      recoveryCommands: ["git cherry-pick --abort", "git reset --hard ORIG_HEAD"],
      executed: false,
      summary: "BranchDoctor diagnosed \"partial-cherry-pick\" (severity: medium). "
        + "Recovery plan: 2 commands (risk: low). Dry-run only — no commands were executed. "
        + "Manual steps still needed: re-apply abc123 by hand"
    })
  }))

it.effect("runs only the safe commands when asked to execute", () =>
  Effect.gen(function*() {
    const { actions, answer, turns } = script()
    const output = yield* Kit.run(BranchDoctor, { repoPath: "/repo", baseBranch: "develop", autoExecute: true }, {
      filename: join(directory, "execute.sqlite"),
      executionId: "branch-doctor-execute",
      script: answer,
      actions
    })

    // The execute step ran after the plan and was handed only the safe command.
    expect(turns).toEqual([
      "inspect against develop, symptoms []",
      "diagnose feature/login",
      "plan for partial-cherry-pick",
      "execute in /repo: git cherry-pick --abort"
    ])
    expect(output.executed).toBe(true)
    expect(output.summary).toBe(
      "BranchDoctor diagnosed \"partial-cherry-pick\" (severity: medium). "
        + "Recovery plan: 2 commands (risk: low). Executed 1 safe commands, skipped 1 unsafe. "
        + "Manual steps still needed: re-apply abc123 by hand"
    )
  }))

it.effect("reports an execution with a failing command as not executed", () =>
  Effect.gen(function*() {
    const { actions, answer } = script(128)
    const output = yield* Kit.run(BranchDoctor, { repoPath: "/repo", autoExecute: true }, {
      filename: join(directory, "execute-failed.sqlite"),
      executionId: "branch-doctor-execute-failed",
      script: answer,
      actions
    })

    expect(output.executed).toBe(false)
    expect(output.summary).toContain("Executed 1 safe commands, skipped 1 unsafe.")
  }))
