import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Inventory as InventoryDocument, Job } from "../src/contract/Inventory.ts"
import { Inventory } from "../src/contract/Inventory.ts"
import { files } from "../src/generate/index.ts"

const cli = fileURLToPath(new URL("../../smithers/bin/smithers.mjs", import.meta.url))
const slow = 180_000
const prefix = "//:"

const fixture = (name: string): InventoryDocument =>
  Schema.decodeUnknownSync(Inventory)(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")))

const run = (cwd: string, command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A real git repository holding `sources` and the files generated for `document`. */
const repository = (document: InventoryDocument, sources: Readonly<Record<string, string>> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-generate-"))
  expect(run(root, "git", ["init", "-q", "."]).status).toBe(0)
  const generated = Effect.runSync(files(document))
  const all = [...Object.entries(sources), ...generated.map((file) => [file.path, file.content] as const)]
  for (const [path, content] of [[".gitignore", ".flows\n"] as const, ...all]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

interface PlannedTarget {
  readonly label: string
  readonly target: string
  readonly cacheable: boolean
  readonly dependencies: ReadonlyArray<string>
}

const plan = (root: string): ReadonlyArray<PlannedTarget> => {
  const result = run(root, process.execPath, [cli, "ci", "//...", "--plan", "--format", "json"])
  expect(result.stderr).not.toContain("error")
  expect(result.status).toBe(0)
  return (JSON.parse(result.stdout) as { readonly targets: ReadonlyArray<PlannedTarget> }).targets
}

/** Runs every target and returns each one's status from the run's results file. */
const execute = (root: string, name: string) => {
  // The CLI refuses to overwrite a results file, so each run names its own.
  const resultsFile = join(root, ".flows", `${name}.json`)
  const result = run(root, process.execPath, [cli, "ci", "//...", "--jobs", "1", "--results-file", resultsFile])
  const record = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  const statuses = new Map(record.results.map((target) => [target.label.slice(prefix.length), target.status]))
  return { status: result.status, statuses }
}

const job = (id: string, commands: ReadonlyArray<string>, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: [],
  matrix: [],
  steps: commands.map((command, index) => ({ id: `${id}:${index + 1}`, command, cwd: "", env: {}, secrets: [] })),
  unsupported: [],
  ...extra
})

const document = (jobs: ReadonlyArray<Job>): InventoryDocument => ({
  version: 1,
  repository: "example/real",
  commit: "0000000000000000000000000000000000000004",
  toolchains: [],
  jobs
})

describe("generated files under the real smthrs", () => {
  it("plans one target per Justfile step with the inventory's dependencies", () => {
    const root = repository(fixture("inventory.justfile-zig.json"))
    try {
      const targets = plan(root)
      expect(targets.map((target) => [target.label, target.target, target.cacheable, target.dependencies])).toEqual([
        [`${prefix}justfile-build-1`, "Shell.Build", false, []],
        [`${prefix}justfile-test-1`, "Shell.Test", true, [`${prefix}justfile-build-1`]]
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("plans one target per GitHub Actions step for this machine's system", () => {
    const root = repository(fixture("inventory.github-actions-bun.json"))
    const variant = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"
    try {
      expect(plan(root).map((target) => [target.label, target.dependencies])).toEqual([
        [`${prefix}ci.yml-test-1--${variant}`, []],
        [`${prefix}ci.yml-test-2--${variant}`, [`${prefix}ci.yml-test-1--${variant}`]]
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("gives each target the verdict its command gives, and replays only safe ones", () => {
    const inventory = document([
      job("good", ["mkdir -p made && echo built > made/file", "test -f made/file", "grep -q source input.txt"]),
      job("bad", ["echo fail-first; false\necho unreachable"]),
      job("blocked", ["true"], { needs: ["bad"] }),
      job("recipe", ["#!/usr/bin/env bash\n[[ -f input.txt ]]"], { source: "justfile" })
    ])
    const root = repository(inventory, { "input.txt": "source\n" })
    try {
      const first = execute(root, "first")
      expect(first.status).toBe(1)
      expect(Object.fromEntries(first.statuses)).toEqual({
        "good-1": "ran",
        "good-2": "ran",
        "good-3": "ran",
        "bad-1": "failed",
        "blocked-1": "skipped",
        "recipe-1": "ran"
      })

      // A clean checkout: what setup steps left behind is gone.
      rmSync(join(root, "made"), { recursive: true })
      const second = execute(root, "second")
      expect(second.statuses.get("good-1")).toBe("ran")
      expect(second.statuses.get("good-2")).toBe("ran")
      expect(second.statuses.get("good-3")).toBe("hit")

      writeFileSync(join(root, "input.txt"), "changed\n")
      const third = execute(root, "third")
      expect(third.statuses.get("good-3")).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)
})
