import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dependency } from "../../../examples/use-cases/dependency-update.vibe"
import { DependencyUpdate, layer, Verify } from "../../../examples/use-cases/dependency-update.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "dependency-update-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const dep = (
  name: string,
  type: (typeof Dependency.Type)["type"],
  breaking = false,
  changelog?: string
): typeof Dependency.Type => ({
  name,
  current: "1.0.0",
  latest: type === "major" ? "2.0.0" : type === "minor" ? "1.1.0" : "1.0.1",
  type,
  breaking,
  ...(changelog === undefined ? {} : { changelog })
})

/**
 * A scanner that answers with `outdated`, updaters that report the version
 * move their prompt names (answering off-schema for names in `broken`, and
 * with status `failed` for names in `failing`), and a verify step that passes
 * when `passes` is set. Every request is recorded.
 */
const script = (options: {
  readonly outdated: ReadonlyArray<typeof Dependency.Type>
  readonly broken?: ReadonlyArray<string>
  readonly failing?: ReadonlyArray<string>
  readonly passes?: boolean
}) => {
  const scanned: Array<string> = []
  const updated: Array<string> = []
  const verified: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a dependency analyst")) {
      scanned.push(/Check for outdated dependencies:\n(Directory: .+\nCommand: .+\nAlso check: .+)/.exec(asked)![1]!)
      return { outdated: options.outdated, totalOutdated: options.outdated.length }
    }
    const update = /Update (\S+): (\S+) -> (\S+) \((\w+)\)\nDirectory: (.+)/.exec(asked)
    if (update !== null) {
      const [, name, from, to, type, dir] = update
      const changelog = /\nChangelog: (.+)/.exec(asked)?.[1]
      updated.push(`${name} ${type} in ${dir}${changelog === undefined ? "" : ` with ${changelog}`}`)
      if (options.broken?.includes(name!)) return { unexpected: true }
      const status = options.failing?.includes(name!) ? "failed" : "updated"
      return { name, from, to, status, notes: `${status} ${name}` }
    }
    return undefined
  }
  const verify = Verify.toLayer(({ buildCmd, directory: dir, testCmd, typecheckCmd }) =>
    Effect.sync(() => {
      verified.push(`${dir}: ${typecheckCmd}; ${testCmd}; ${buildCmd}`)
      const passes = options.passes ?? true
      return { passed: passes, typecheck: true, tests: passes, build: true, errors: passes ? [] : ["2 tests failed"] }
    })
  )
  return { answer, scanned, updated, verified, actions: Layer.mergeAll(layer, verify) }
}

it.effect("updates only the safe candidates, verifies, and holds major and breaking updates back", () =>
  Effect.gen(function*() {
    const { actions, answer, scanned, updated, verified } = script({
      outdated: [
        dep("lodash", "patch"),
        dep("@types/node", "minor", false, "adds fetch types"),
        dep("react", "major", true),
        dep("zod", "minor", true)
      ]
    })
    const report = yield* Kit.run(DependencyUpdate, { directory: "app" }, {
      filename: join(directory, "safe.sqlite"),
      executionId: "dependency-update-safe",
      script: answer,
      actions
    })

    // The scanner got 0.x's default command and lockfile.
    expect(scanned).toEqual(["Directory: app\nCommand: npm outdated --json\nAlso check: package-lock.json"])
    // Only the patch and the non-breaking minor update ran, each with its changelog when it had one.
    expect([...updated].sort()).toEqual(["@types/node minor in app with adds fetch types", "lodash patch in app"])
    expect(verified).toEqual(["app: npx tsc --noEmit; npm test; npm run build"])
    expect(report).toEqual({
      updated: 2,
      skipped: 2,
      failed: 0,
      breaking: 2,
      verified: true,
      summary: "Updated 2/4 deps. 2 major updates need manual review."
    })
  }))

it.effect("drops a failed updater's result and counts an update that reported failure", () =>
  Effect.gen(function*() {
    const { actions, answer, updated, verified } = script({
      outdated: [dep("a", "patch"), dep("b", "patch"), dep("c", "minor")],
      broken: ["a"],
      failing: ["b"],
      passes: false
    })
    const report = yield* Kit.run(DependencyUpdate, { directory: "app", testCmd: "pnpm test" }, {
      filename: join(directory, "continue-on-fail.sqlite"),
      executionId: "dependency-update-continue-on-fail",
      script: answer,
      actions
    })

    // All three updaters were asked; the broken one failed without stopping the others.
    expect(updated).toContain("a patch in app")
    expect(updated).toContain("b patch in app")
    expect(updated).toContain("c minor in app")
    expect(verified).toEqual(["app: npx tsc --noEmit; pnpm test; npm run build"])
    expect(report).toEqual({
      updated: 1,
      skipped: 0,
      failed: 1,
      breaking: 0,
      verified: false,
      summary: "Updated 1/3 deps. 0 major updates need manual review."
    })
  }))

it.effect("skips the updates and the verification when nothing is safe to update", () =>
  Effect.gen(function*() {
    const { actions, answer, updated, verified } = script({
      outdated: [dep("react", "major", true), dep("vite", "major")]
    })
    const report = yield* Kit.run(DependencyUpdate, { directory: "app" }, {
      filename: join(directory, "nothing-safe.sqlite"),
      executionId: "dependency-update-nothing-safe",
      script: answer,
      actions
    })

    expect(updated).toEqual([])
    expect(verified).toEqual([])
    expect(report).toEqual({
      updated: 0,
      skipped: 2,
      failed: 0,
      breaking: 1,
      verified: false,
      summary: "Updated 0/2 deps. 1 major updates need manual review."
    })
  }))
