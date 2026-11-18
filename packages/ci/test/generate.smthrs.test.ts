import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { Ci, Inventory as InventoryDocument, Job } from "../src/contract/Inventory.ts"
import { Inventory, shell } from "../src/contract/Inventory.ts"
import { files } from "../src/generate/index.ts"
import { workflowPath } from "../src/generate/Render.ts"

const cli = fileURLToPath(new URL("../../smithers/bin/smithers.mjs", import.meta.url))
const slow = 180_000
const prefix = "//:"

const fixture = (name: string): InventoryDocument =>
  Schema.decodeUnknownSync(Inventory)(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")))

const run = (cwd: string, command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A real git repository holding `sources` and the files generated for `document`. */
const repository = (document: InventoryDocument, sources: Readonly<Record<string, string>> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-generate-"))
  expect(run(root, "git", ["init", "-q", "."]).status).toBe(0)
  const generated = Effect.runSync(files(document as Ci))
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
  readonly keyPreview: unknown
}

/** True when this machine can hold a target to its declared reads: bubblewrap on Linux, seatbelt on macOS. */
const confines = process.platform === "darwin" || spawnSync("bwrap", ["--version"]).status === 0

const plan = (root: string): ReadonlyArray<PlannedTarget> => {
  const result = run(root, process.execPath, [cli, "ci", "//...", "--plan", "--format", "json"])
  expect(result.stderr).not.toContain("error")
  expect(result.status).toBe(0)
  return (JSON.parse(result.stdout) as { readonly targets: ReadonlyArray<PlannedTarget> }).targets
}

/** Runs every target and returns each one's status from the run's results file. */
const execute = (root: string, name: string, env: NodeJS.ProcessEnv = process.env) => {
  // The CLI refuses to overwrite a results file, so each run names its own.
  const resultsFile = join(root, ".flows", `${name}.json`)
  const result = run(root, process.execPath, [cli, "ci", "//...", "--jobs", "1", "--results-file", resultsFile], env)
  const record = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  const statuses = new Map(record.results.map((target) => [target.label.slice(prefix.length), target.status]))
  return { status: result.status, statuses, output: `${result.stdout}${result.stderr}` }
}

const job = (id: string, commands: ReadonlyArray<string>, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
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
      job("blocked", ["true"], { needs: ["bad"] })
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
        "blocked-1": "skipped"
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

  it("runs a step under the shell the baseline runs it under, never /bin/sh", () => {
    // `source`, `time` and `[[` are bash words: dash, which is /bin/sh on Ubuntu, refuses each of them.
    const commands = ["source scripts/check.sh", "time true", "#!/usr/bin/env bash\n[[ -f input.txt ]]"]
    const sources = { "input.txt": "source\n", "scripts/check.sh": "echo checked\n" }
    const root = repository(
      document([
        job("github", commands.slice(0, 2)),
        job("recipe", commands.slice(2), { source: "justfile", name: "test", triggers: [] })
      ]),
      sources
    )
    try {
      // The baseline runs each command as `Inventory.shell` then the command, and each passes.
      for (const command of commands) expect(run(root, shell[0], [...shell.slice(1), command]).status).toBe(0)
      expect(Object.fromEntries(execute(root, "only").statuses)).toEqual({
        "github-1": "ran",
        "github-2": "ran",
        "recipe-1": "ran"
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("plans and runs steps whose ids differ only by letter case, each as its own target", () => {
    const steps = ["ci:Build", "ci:build", "ci:a b", "ci:a-b"].map((id) => ({
      id,
      command: id === "ci:build" ? "false" : "true",
      cwd: "",
      env: {},
      secrets: []
    }))
    // One job per step, so one failure skips nothing.
    const root = repository(document(steps.map((step, index) => ({ ...job(`j${index}`, []), steps: [step] }))))
    try {
      // Smithers build refuses a package whose labels differ only by case: the plan succeeding is the proof.
      const labels = plan(root).map((target) => target.label.slice(prefix.length))
      expect(labels).toHaveLength(4)
      expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(4)
      expect(labels.slice(0, 1)).toEqual(["ci-Build"])
      const { statuses } = execute(root, "only")
      // The failing command belongs to `ci:build` alone.
      expect([...statuses.values()].sort()).toEqual(["failed", "ran", "ran", "ran"])
      expect(statuses.get("ci-Build")).toBe("ran")
      expect([...statuses].find(([label]) => /^ci-build-/.test(label))?.[1]).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("sees a changed file through the shared file group of a large graph", () => {
    const commands = Array.from({ length: 33 }, (_, index) => index === 32 ? "grep -q source input.txt" : "true")
    const root = repository(document([job("many", commands)]), { "input.txt": "source\n" })
    try {
      expect(plan(root).map((target) => target.label)).toContain(`${prefix}_repository`)
      expect(execute(root, "first").statuses.get("many-33")).toBe("ran")
      expect(execute(root, "second").statuses.get("many-33")).toBe("hit")
      writeFileSync(join(root, "input.txt"), "changed\n")
      expect(execute(root, "third").statuses.get("many-33")).toBe("failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("reruns only the package steps that read the changed file", () => {
    const part = (name: string, command: string) => ({
      id: `ci:2:${name}`,
      command,
      cwd: "",
      env: {},
      secrets: [],
      inputs: ["*", `packages/${name}/**`],
      from: "ci:2"
    })
    // The split step is its job's only step: no earlier step wrote a file its targets could read.
    const steps = [
      part("a", "grep -q source packages/a/input.txt"),
      part("b", "grep -q source packages/b/input.txt")
    ]
    const root = repository(document([{ ...job("ci", []), steps }]), {
      "packages/a/input.txt": "source\n",
      "packages/b/input.txt": "source\n",
      "readme.md": "x\n",
      "docs/guide.md": "x\n"
    })
    try {
      // Neither package step follows the other.
      const before = plan(root)
      expect(before.map((target) => [target.label, target.cacheable, target.dependencies])).toEqual([
        [`${prefix}ci-2-a`, true, []],
        [`${prefix}ci-2-b`, true, []]
      ])
      const keys = () =>
        Object.fromEntries(plan(root).map((target) => [target.label, JSON.stringify(target.keyPreview)]))
      const original = keys()
      // A file only package b's step reads changes b's key and no other.
      writeFileSync(join(root, "packages/b/input.txt"), "source again\n")
      const edited = keys()
      expect(edited[`${prefix}ci-2-a`]).toBe(original[`${prefix}ci-2-a`])
      expect(edited[`${prefix}ci-2-b`]).not.toBe(original[`${prefix}ci-2-b`])
      // A file no step names changes no package step's key; a root file changes both.
      writeFileSync(join(root, "docs/guide.md"), "changed\n")
      expect(keys()).toEqual(edited)
      writeFileSync(join(root, "readme.md"), "changed\n")
      const rooted = keys()
      expect(rooted[`${prefix}ci-2-a`]).not.toBe(edited[`${prefix}ci-2-a`])
      expect(rooted[`${prefix}ci-2-b`]).not.toBe(edited[`${prefix}ci-2-b`])
      // Running needs a machine that can confine a target to its declared reads.
      if (!confines) return
      const statuses = (name: string) => Object.fromEntries(execute(root, name).statuses)
      expect(statuses("first")).toEqual({ "ci-2-a": "ran", "ci-2-b": "ran" })
      expect(statuses("second")).toEqual({ "ci-2-a": "hit", "ci-2-b": "hit" })
      writeFileSync(join(root, "packages/b/input.txt"), "changed\n")
      expect(statuses("third")).toEqual({ "ci-2-a": "hit", "ci-2-b": "failed" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it.runIf(confines)("fails a package step that reads a file outside its inputs", () => {
    const leak = {
      id: "ci:1:a",
      // Its inputs name package a only, and it reads package b.
      command: "grep -q source packages/b/input.txt",
      cwd: "",
      env: {},
      secrets: [],
      inputs: ["packages/a/**"],
      from: "ci:1"
    }
    const root = repository(document([{ ...job("ci", []), steps: [leak] }]), {
      "packages/a/input.txt": "source\n",
      "packages/b/input.txt": "source\n"
    })
    try {
      // The command would pass in the open: the file is there and holds the word.
      expect(run(root, "sh", ["-c", leak.command]).status).toBe(0)
      expect(Object.fromEntries(execute(root, "only").statuses)).toEqual({ "ci-1-a": "failed" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("lets a package step read what an earlier step built, and reruns it when that step's source changes", () => {
    const steps = [
      // The build copies a file no package step names into a directory git ignores.
      {
        id: "ci:1",
        command: "mkdir -p packages/a/dist && cp config/value packages/a/dist/out",
        cwd: "",
        env: {},
        secrets: [],
        inputs: ["config/**"],
        from: "ci:1"
      },
      {
        id: "ci:2:a",
        command: "grep -q good packages/a/dist/out && grep -q source packages/a/src.txt",
        cwd: "",
        env: {},
        secrets: [],
        inputs: ["packages/a/**"],
        from: "ci:2"
      },
      {
        id: "ci:2:b",
        command: "grep -q source packages/b/src.txt",
        cwd: "",
        env: {},
        secrets: [],
        inputs: ["packages/b/**"],
        from: "ci:2"
      }
    ]
    const root = repository(document([{ ...job("ci", []), steps }]), {
      "config/value": "good\n",
      "packages/a/.gitignore": "dist\n",
      "packages/a/src.txt": "source\n",
      "packages/b/src.txt": "source\n"
    })
    try {
      const statuses = (name: string) => Object.fromEntries(execute(root, name).statuses)
      // Held to `packages/a/**`, the step could not read `dist/out`: git ignores it, so no input names it.
      expect(statuses("first")).toEqual({ "ci-1": "ran", "ci-2-a": "ran", "ci-2-b": "ran" })
      expect(statuses("second")).toEqual({ "ci-1": "ran", "ci-2-a": "hit", "ci-2-b": "hit" })
      // The file the build read changes. A key made of `packages/a/**` would not: the step would hit, and pass stale.
      writeFileSync(join(root, "config/value"), "bad\n")
      expect(statuses("third")).toEqual({ "ci-1": "ran", "ci-2-a": "failed", "ci-2-b": "ran" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("installs the read sandbox in the workflow, without which a Linux runner fails every confined target", () => {
    const held = {
      id: "ci:1:a",
      command: "grep -q source packages/a/input.txt",
      cwd: "",
      env: {},
      secrets: [],
      inputs: ["packages/a/**"],
      from: "ci:1"
    }
    const inventory = document([{ ...job("ci", []), steps: [held], runsOn: "ubuntu-latest" }])
    const workflow = parseYaml(
      Effect.runSync(files(inventory as Ci)).find((file) => file.path === workflowPath)?.content ?? ""
    ) as { readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<Record<string, string>> } } }
    const steps = workflow.jobs.ci.steps
    const install = steps.findIndex((step) => step["name"] === "Install the read sandbox")
    // The step runs on Linux runners only, before the targets, and is a script bash reads.
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(steps.findIndex((step) => step["run"]?.includes("smthrs ci")))
    expect(steps[install]?.["if"]).toBe("runner.os == 'Linux'")
    expect(steps[install]?.["run"]).toContain("--no-install-recommends bubblewrap")
    expect(run(tmpdir(), "bash", ["-n", "-c", steps[install]?.["run"] as string]).status).toBe(0)
    // What the step prevents, on a Linux machine that has bubblewrap: take it off PATH, as on a fresh runner.
    if (process.platform !== "linux" || !confines) return
    const root = repository(inventory, { "packages/a/input.txt": "source\n" })
    try {
      const without = (process.env["PATH"] ?? "").split(delimiter).filter((directory) =>
        !existsSync(join(directory, "bwrap"))
      )
      const bare = execute(root, "bare", { ...process.env, PATH: without.join(delimiter) })
      expect(Object.fromEntries(bare.statuses)).toEqual({ "ci-1-a": "failed" })
      expect(bare.output).toContain("bwrap is not on PATH (install the bubblewrap package)")
      expect(Object.fromEntries(execute(root, "installed").statuses)).toEqual({ "ci-1-a": "ran" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("replays a verdict in a fresh checkout that restored the workflow's cache", () => {
    const inventory = document([job("check", ["grep -q source input.txt"])])
    const sources = { "input.txt": "source\n" }
    const first = repository(inventory, sources)
    const second = repository(inventory, sources)
    try {
      expect(execute(first, "first").statuses.get("check-1")).toBe("ran")
      cpSync(join(first, ".flows", "cache"), join(second, ".flows", "cache"), { recursive: true })
      expect(execute(second, "second").statuses.get("check-1")).toBe("hit")
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  }, slow)
})
