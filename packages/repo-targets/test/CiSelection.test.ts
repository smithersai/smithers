import * as Target from "@smthrs/targets/Target"
import * as Vitest from "@smthrs/targets/Vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import * as Yaml from "yaml"
import { Package } from "../PACKAGE.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

const root = resolve(import.meta.dirname, "../../..")

it("CI runs the package pattern that holds the coverage-enabled test target and runner", () => {
  const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")
  const jobs = Yaml.parse(ci).jobs as Record<string, { steps: Array<{ run?: string }> }>
  for (const [id, verb] of [["test", "ci"], ["packages", "test"]]) {
    const matches = Object.entries(jobs).filter(([name]) => name === id || name.startsWith(`${id}-`))
      .flatMap(([, job]) => job.steps).filter((step) => step.run?.startsWith(`pnpm exec smthrs ${verb} `))
      .filter((step) => step.run?.includes("'//packages/repo-targets:*'"))
    expect(matches).toHaveLength(1)
    expect(matches[0]!.run).toContain("--jobs 2 --known-red '.github/ci-known-red.json' --results-file")
  }

  const attrs = Target.metadata(Package.test).attrs as Vitest.Attrs
  expect(attrs).toMatchObject({
    cwd: "packages/repo-targets",
    config: { _tag: "File", path: "vitest.config.ts" },
    coverage: true,
    passWithNoTests: false,
    tests: [{ _tag: "Glob", pattern: "test/**/*.test.ts", exclude: [] }],
    sources: [
      { _tag: "Glob", pattern: "src/**/*.ts", exclude: [] },
      { _tag: "Glob", pattern: "test/**/*.ts", exclude: [] },
      { _tag: "Glob", pattern: "test-utils/**", exclude: [] },
      { _tag: "File", path: "//packages/smithers/flows/database/src/TestSchemas.ts" },
      { _tag: "Glob", pattern: "scripts/**", exclude: [] },
      { _tag: "Glob", pattern: "ci/**", exclude: [] },
      { _tag: "File", path: "PACKAGE.ts" }
    ]
  })
  // Fill only the workspace manager; all runner settings come from PACKAGE.ts.
  const runner = plannedCalls(Vitest.Vitest({ ...attrs, packageManager }))
  expect(runner).toHaveLength(1)
  expect(runner[0]?.payload).toMatchObject({
    cwd: "packages/repo-targets",
    argv: ["pnpm", "exec", "vitest", "run", "--config", "vitest.config.ts", "--environment", "node"]
  })
})

// Spawns the real CLI against this checkout, so it pays the whole workspace
// walk. Discovery prunes nested checkouts, CACHEDIR.TAG caches, and the
// WORKSPACE.ts `discovery.prune` paths; an unpruned cache shows up here first.
it("CI's package pattern discovers the repo-targets test target", () => {
  const child = spawnSync(process.execPath, [
    resolve(root, "packages/smithers/src/bin.ts"),
    "targets",
    "//packages/...",
    "--json"
  ], { cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] })
  expect(child.status, child.stderr || child.stdout || String(child.error)).toBe(0)
  const result = JSON.parse(child.stdout)
  expect(result.query).toBe("//packages/...")
  expect(result.targets.filter((row: { readonly label: string }) => row.label === "//packages/repo-targets:test"))
    .toEqual([{ label: "//packages/repo-targets:test", target: "Vitest", kinds: ["test"] }])
}, 90_000)
