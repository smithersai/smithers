/**
 * The migration against a real model.
 *
 * Everything else in `test/flow` proves the machinery with the seat scripted.
 * This one proves the part a script cannot: that the contract, the prompt, the
 * captured sources, and the mapping snippets are enough for a model to
 * actually rewrite a 0.x workflow into a flow that typechecks and that the
 * registry discovers.
 *
 * It runs only with credentials, and skips with a reason otherwise, because a
 * test that quietly passes without doing the thing is worse than no test. It
 * costs real money and real minutes; that is the price of knowing.
 *
 * Two variables, both documented under "Testing it against a real model" in
 * `packages/smithers/migrate/README.md`: `SMITHERS_MIGRATE_SEAT` names the
 * `provider:model` seat, and that provider's key pays for it. A key alone is
 * not enough on purpose: this package hard-codes no model id, so nothing here
 * may decide which model to spend someone's money on.
 *
 * The first case spawns the built bin, because that is what an operator runs
 * and it is the only path that exercises the flags, the exit code, and the
 * rendering together. Its `typecheck` and `test` are still overridden, and that
 * is a deviation with a reason: the migrated fixture imports
 * `@smthrs/*@1.0.0-rc.0`, which is unpublished, so a real install cannot
 * resolve it and a real typecheck cannot run until it is. Discovery, the
 * deterministic checks, and the assertions below do the measuring instead.
 * `packages/smithers/migrate/README.md` records the same thing.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Command from "@smthrs/migrate/flow/Command"
import * as Options from "@smthrs/migrate/flow/Options"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, fixture, runBin } from "../fixtures/helpers.ts"

const keyVariable: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
}

/**
 * The seat this test runs on, when the operator named one and its key is set.
 *
 * Naming the model is the operator's, not the test's. The tool has no default
 * model anywhere — a default is a choice about someone's money — and a test
 * that invented one would be the one place the rule did not hold. It would
 * also fail for the wrong reason on a machine whose key is real and whose
 * balance is not, which is exactly what happened the first time this ran.
 */
const seatFromEnvironment = (): string | undefined => {
  const named = process.env["SMITHERS_MIGRATE_SEAT"]
  if (named === undefined || named === "") return undefined
  const separator = named.indexOf(":")
  const provider = separator < 0 ? "anthropic" : named.slice(0, separator)
  const variable = keyVariable[provider]
  if (variable === undefined) return undefined
  return (process.env[variable] ?? "") === "" ? undefined : named
}

const seat = seatFromEnvironment()
const reason =
  "no model credentials: set SMITHERS_MIGRATE_SEAT to a provider:model seat and that provider's key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY)"

const committed = (root: string): void => {
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@local",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@local"
  }
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore", env: environment })
  }
}

/** The path both single-workflow live journeys inspect after applying. */
const singleWorkflowFlow = (root: string): string => join(root, Options.defaultFlowsDir, "simple-workflow", "flow.ts")

describe("single-workflow output layout", () => {
  it("locates the committed migrated flow at the path inspected by the live journeys", () => {
    expect(existsSync(singleWorkflowFlow(fixture("jsx-single.migrated")))).toBe(true)
  })
})

describe("apply against a real model", () => {
  if (seat === undefined) {
    it.skip(`migrates a single-file JSX project through the bin (${reason})`, () => {})
    it.skip(`records what a single-file project could not settle (${reason})`, () => {})
    it.skip(`refuses what it cannot translate in a multi-workflow pack (${reason})`, () => {})
    return
  }

  it("migrates a single-file JSX project into a flow the registry discovers, through the bin", () => {
    const root = copyFixture("jsx-single")
    committed(root)

    const result = runBin([
      "--root",
      root,
      "--apply",
      "--seat",
      seat,
      "--max-repair-rounds",
      "2",
      "--json",
      // See the header: the 1.0 packages the rewrite imports are unpublished,
      // so install and typecheck cannot resolve them yet.
      "--verify-typecheck",
      "",
      "--verify-test",
      "node -e \"process.exit(0)\""
    ])

    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as {
      units: ReadonlyArray<{ id: string; status: string; verification?: { discovery?: { exitCode: number } } }>
    }
    const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
    expect(workflow?.status).toBe("migrated")
    expect(report.units.find((unit) => unit.id === "dependencies")?.status).toBe("migrated")
    expect(report.units.find((unit) => unit.id === "project")?.status).toBe("migrated")

    const flow = singleWorkflowFlow(root)
    expect(existsSync(flow)).toBe(true)
    const source = readFileSync(flow, "utf8")
    expect(source).toContain("@smthrs/agent/AgentAction")
    expect(source).toMatch(/@smthrs\/(flow|core)/)
    // The one thing the whole tool is for: the old facade is gone.
    expect(source).not.toMatch(/from\s+["']smthrs/)
    expect(source).not.toContain("jsxImportSource")
    expect(source).not.toContain("as any")
    expect(workflow?.verification?.discovery?.exitCode).toBe(0)
    // And the project the operator is left with is a 1.0 project.
    const manifest = readFileSync(join(root, "package.json"), "utf8")
    expect(manifest).not.toContain("\"smthrs\"")
    expect(readFileSync(join(root, "tsconfig.json"), "utf8")).not.toContain("jsxImportSource")
  }, 30 * 60_000)

  it.effect("records what the same project's report says it could not settle", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)

      const report = yield* Command.runNode({
        root,
        mode: "apply",
        seat,
        maxRepairRounds: 2,
        commands: { typecheck: [], test: "node -e \"process.exit(0)\"" }
      }, { environment: process.env })

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.status).toBe("migrated")

      const flow = singleWorkflowFlow(root)
      expect(existsSync(flow)).toBe(true)
      const source = readFileSync(flow, "utf8")
      expect(source).toContain("@smthrs/agent/AgentAction")
      expect(source).toMatch(/@smthrs\/(flow|core)/)
      // The one thing the whole tool is for: the old facade is gone.
      expect(source).not.toMatch(/from\s+["']smthrs/)
      expect(source).not.toContain("jsxImportSource")
      expect(source).not.toContain("as any")
      expect(workflow?.verification?.discovery?.exitCode).toBe(0)
    }), 30 * 60_000)

  it.effect(
    "records what a multi-workflow pack cannot translate instead of imitating it",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("plue-pack")
        committed(root)

        const report = yield* Command.runNode({
          root,
          mode: "apply",
          seat,
          maxRepairRounds: 2,
          allowUnsafe: "all",
          commands: { typecheck: [], test: "node -e \"process.exit(0)\"" }
        }, { environment: process.env })

        // `release.tsx` is written against a foreign authoring API, so there is
        // nothing to translate it into and the tool has to say so about that
        // file by name. The scanner's `unknown-authoring-api` warning travels
        // in the unit brief, so the agent is told rather than left to guess.
        // Design 7.2 asks for the unit to be `blocked`, which is a plan-time
        // status the scanner assigns only to a construct with no counterpart;
        // the run-time equivalent is the report entry, and that is what is
        // asserted.
        const release = report.unsupported.filter((entry) => entry.unit === "workflow:release")
        expect(release.map((entry) => entry.file)).toContain(".smithers/workflows/release.tsx")
        expect(report.followUps.some((entry) => entry.unit === "workflow:release")).toBe(true)
        // `ralph.tsx` runs an unbounded loop, which the 1.0 model refuses: a
        // bounded recursion needs fuel, and choosing it is a person's decision.
        const decisions = report.units.flatMap((unit) => unit.decisions)
        const unresolved = report.unresolved.map((entry) => `${entry.construct} ${entry.suggestion}`)
        expect([...decisions.map((entry) => entry.construct), ...unresolved].join("\n")).toMatch(
          /Loop|Ralph|maxIterations/
        )
      }),
    60 * 60_000
  )
})
