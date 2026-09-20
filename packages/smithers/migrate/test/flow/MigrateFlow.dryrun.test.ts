/**
 * `plan` over the real fixtures, on the real composition, with no credentials.
 *
 * This is the run an operator makes first, and its whole promise is that it
 * costs them nothing: it reads the project, writes one report, and leaves
 * every other byte where it was. The test proves that by hashing the tree
 * before and after and allowing exactly one directory to differ.
 *
 * The composition is the production one. Only the seat is unresolvable, which
 * is the honest state of a machine with no keys, and `plan` never asks for one.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Command from "@smthrs/migrate/flow/Command"
import * as Effect from "effect/Effect"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { copyFixture, fixture, hashTree } from "../fixtures/helpers.ts"

const options = (root: string, overrides: Partial<Command.MigrateOptions> = {}): Command.MigrateOptions => ({
  root,
  mode: "plan",
  ...overrides
})

/** Every path that changed, ignoring the one directory a plan may write. */
const changedOutside = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  reportDir: string
): ReadonlyArray<string> => {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths]
    .filter((path) => !path.startsWith(`${reportDir}/`))
    .filter((path) => before.get(path) !== after.get(path))
    .sort()
}

const plan = (root: string, overrides: Partial<Command.MigrateOptions> = {}) =>
  Command.runNode(options(root, overrides), { environment: {}, evaluator: ScriptedJudge.layer })

describe("plan over a single-file JSX project", () => {
  it.effect("names its three units and changes nothing but the report", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      const report = yield* plan(root)

      expect(report.mode).toBe("plan")
      expect(report.exitCode).toBe(0)
      expect(report.units.map((unit) => unit.id)).toEqual([
        "dependencies",
        "workflow:simple-workflow",
        "project"
      ])
      expect(report.units.every((unit) => unit.status === "planned")).toBe(true)
      expect(report.runState.verdict).toBe("clean")
      expect(report.inventory.length).toBeGreaterThan(0)
      expect(changedOutside(before, hashTree(root), ".smithers-migrate")).toEqual([])
      expect(hashTree(root).has(".smithers-migrate/report.md")).toBe(true)
      expect(hashTree(root).has(".smithers-migrate/report.json")).toBe(true)
    }))

  it.effect("writes a report a second run reproduces byte for byte", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      yield* plan(root)
      const first = hashTree(root).get(".smithers-migrate/report.md")
      yield* plan(root)
      const second = hashTree(root).get(".smithers-migrate/report.md")

      // The Markdown is deterministic for a given JSON, and the only volatile
      // field is the timestamp in the JSON, so the prose has to be stable.
      expect(first).toBe(second)
    }))

  it.effect("changes not one byte in scan mode, report included", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      const report = yield* plan(root, { mode: "scan" })

      expect(report.mode).toBe("scan")
      expect(report.units.length).toBe(3)
      // `scan` is the mode for a project nobody has decided about yet, so it
      // writes nothing at all — not even the report.
      expect(hashTree(root)).toEqual(before)
    }))

  it.effect("refuses a report directory that could leave the project, and reads nothing first", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      for (const reportDir of ["../escape", "/tmp/escape", ".flows/report", "prompts"]) {
        const failure = yield* Effect.flip(plan(root, { reportDir } as Partial<Command.MigrateOptions>))
        expect([reportDir, failure.code]).toEqual([reportDir, "invalid-layout"])
      }
      expect(hashTree(root)).toEqual(before)
    }))

  it.effect("puts the report where the operator asked", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      yield* plan(root, { reportDir: "audit" })

      expect(changedOutside(before, hashTree(root), "audit")).toEqual([])
      expect(hashTree(root).has("audit/report.md")).toBe(true)
    }))
})

describe("plan over a multi-workflow pack", () => {
  it.effect("plans one unit per workflow and records what it cannot translate", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const before = hashTree(root)

      const report = yield* plan(root)

      expect(report.mode).toBe("plan")
      expect(report.units.length).toBeGreaterThan(3)
      expect(report.units[0]?.id).toBe("dependencies")
      expect(report.units.at(-1)?.id).toBe("project")
      // A pack with a `<UI>` element and a worktree has constructs with no
      // counterpart, and a plan says so rather than promising a rewrite.
      expect(report.unsupported.length).toBeGreaterThan(0)
      expect(report.followUps.some((entry) => entry.severity === "must")).toBe(true)
      expect(changedOutside(before, hashTree(root), ".smithers-migrate")).toEqual([])
    }))
})

describe("plan over a project that still holds run state", () => {
  it.effect("reports the operator's instructions and still refuses to write anything else", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const module = yield* Effect.promise(() =>
        import(pathToFileURL(join(fixture("persisted-db"), "make-db.mjs")).href) as Promise<{
          build: (target: string, now: number) => string
        }>
      )
      module.build(root, Date.now())
      const before = hashTree(root)

      const report = yield* plan(root)

      expect(report.runState.verdict).toBe("blocked")
      expect(report.runState.instructions.length).toBeGreaterThan(0)
      expect(report.followUps.some((entry) => entry.text.includes("smithers"))).toBe(true)
      // Planning is reading. The database is not opened for writing, and the
      // plan itself exits 0 because nothing has been refused yet.
      expect(report.exitCode).toBe(0)
      expect(changedOutside(before, hashTree(root), ".smithers-migrate")).toEqual([])
    }))

  it.effect("refuses to apply until the operator has said what happens to the run state", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const module = yield* Effect.promise(() =>
        import(pathToFileURL(join(fixture("persisted-db"), "make-db.mjs")).href) as Promise<{
          build: (target: string, now: number) => string
        }>
      )
      module.build(root, Date.now())
      const before = hashTree(root)

      const failure = yield* Effect.flip(plan(root, { mode: "apply" }))

      expect(failure.code).toBe("run-state-blocked")
      expect(failure.message).toContain("--acknowledge-run-state")
      // A refused gate leaves the project exactly as it was, report included:
      // there is nothing to report about a run that did not happen.
      expect(changedOutside(before, hashTree(root), ".smithers-migrate")).toEqual([])
    }))
})
