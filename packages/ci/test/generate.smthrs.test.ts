import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { Ci, Inventory as InventoryDocument, Job } from "../src/contract/Inventory.vibe"
import { ci, Inventory, shell } from "../src/contract/Inventory.vibe"
import { files } from "../src/generate/index.vibe"
import { contentStore, workflowPath } from "../src/generate/Render.ts"
import { assemble } from "../src/inventory/Draft.vibe"
import { readWorkflow } from "../src/inventory/GithubActions.vibe"
import { observes } from "./cli/repo.ts"

const cli = fileURLToPath(new URL("../../smithers/bin/smithers.mjs", import.meta.url))
const slow = 600_000
const prefix = "//:"

const fixture = (name: string): InventoryDocument =>
  Schema.decodeUnknownSync(Inventory)(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")))

const run = (cwd: string, command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Where the runs of a repository keep their cache and write their results: a directory beside the repository, as
 * a runner's temporary directory is. Nothing a run keeps is in the checkout.
 */
const stateOf = (root: string): string => `${root}.state`

const states: Array<string> = []
afterAll(() => {
  for (const state of states) rmSync(state, { recursive: true, force: true })
})

/** A real git repository holding `sources` and the files generated for `document`. */
const repository = (document: InventoryDocument, sources: Readonly<Record<string, string>> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-generate-"))
  mkdirSync(stateOf(root))
  states.push(stateOf(root))
  expect(run(root, "git", ["init", "-q", "."]).status).toBe(0)
  const generated = Effect.runSync(files(document as Ci))
  const all = [...Object.entries(sources), ...generated.map((file) => [file.path, file.content] as const)]
  for (const [path, content] of all) {
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
  const result = run(root, process.execPath, [
    cli,
    "ci",
    "//...",
    "--plan",
    "--format",
    "json",
    "--cache-dir",
    stateOf(root)
  ])
  expect(result.stderr).not.toContain("error")
  expect(result.status).toBe(0)
  return (JSON.parse(result.stdout) as { readonly targets: ReadonlyArray<PlannedTarget> }).targets
}

/** Runs every target and returns each one's status from the run's results file. */
const execute = (root: string, name: string, env: NodeJS.ProcessEnv = process.env) => {
  // The CLI refuses to overwrite a results file, so each run names its own.
  const resultsFile = join(stateOf(root), `${name}.json`)
  const result = run(
    root,
    process.execPath,
    [cli, "ci", "//...", "--jobs", "1", "--cache-dir", stateOf(root), "--results-file", resultsFile],
    env
  )
  // The checkout holds the repository's files and nothing a run keeps.
  expect(existsSync(join(root, ".flows"))).toBe(false)
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
        [`${prefix}justfile-build-1`, "Shell.Test", true, []],
        [`${prefix}justfile-test-1`, "Shell.Test", true, [`${prefix}justfile-build-1`]]
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("runs the recipes of one Justfile in the order listed, in one working tree", () => {
    const recipe = (name: string, command: string): Job =>
      job(`justfile:${name}`, [command], { source: "justfile", file: "justfile", name, triggers: [] })
    // `ci: build test`. Neither recipe needs the other; `just ci` runs `build`, then `test`, which reads what it built.
    const inventory = document([
      recipe("build", "mkdir -p out && echo built > out/artifact"),
      recipe("test", "test -f out/artifact")
    ])
    const root = repository(inventory, { justfile: "ci: build test\n" })
    try {
      expect(plan(root).map((target) => [target.label, target.target, target.dependencies])).toEqual([
        [`${prefix}justfile-build-1`, "Shell.Test", []],
        [`${prefix}justfile-test-1`, "Shell.Test", [`${prefix}justfile-build-1`]]
      ])
      const statuses = (name: string) => Object.fromEntries(execute(root, name).statuses)
      expect(statuses("first")).toEqual({ "justfile-build-1": "ran", "justfile-test-1": "ran" })
      // A clean checkout. Where reads are recorded, neither recipe runs: the build would write what the test read.
      // Elsewhere the build runs again before the test's verdict is replayed.
      rmSync(join(root, "out"), { recursive: true })
      expect(statuses("second")).toEqual({ "justfile-build-1": observes ? "hit" : "ran", "justfile-test-1": "hit" })
      expect(existsSync(join(root, "out"))).toBe(!observes)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // A build that fails skips the test, as `just ci` stops at the first recipe that fails.
    const failing = repository(document([recipe("build", "false"), recipe("test", "true")]), {})
    try {
      expect(Object.fromEntries(execute(failing, "only").statuses)).toEqual({
        "justfile-build-1": "failed",
        "justfile-test-1": "skipped"
      })
    } finally {
      rmSync(failing, { recursive: true, force: true })
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

      // The job's steps ran on its machine: nothing was left in the checkout, as in a clean one.
      expect(existsSync(join(root, "made"))).toBe(false)
      const second = execute(root, "second")
      expect(second.statuses.get("good-1")).toBe(observes ? "hit" : "ran")
      expect(second.statuses.get("good-2")).toBe(observes ? "hit" : "ran")
      expect(second.statuses.get("good-3")).toBe("hit")

      // The last step reads a changed file and runs. Where reads are recorded, no step before it runs; elsewhere
      // both run again. The job's machine holds what its steps made, and the checkout nothing.
      writeFileSync(join(root, "input.txt"), "changed\n")
      const third = execute(root, "third")
      expect(third.statuses.get("good-1")).toBe(observes ? "hit" : "ran")
      expect(third.statuses.get("good-2")).toBe(observes ? "hit" : "ran")
      expect(third.statuses.get("good-3")).toBe("failed")
      expect(existsSync(join(root, "made"))).toBe(false)
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
      // Each command is its own: two jobs that run the same command share one target.
      command: id === "ci:build" ? "false" : `: ${id}`,
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
      expect(statuses("second")).toEqual({ "ci-1": observes ? "hit" : "ran", "ci-2-a": "hit", "ci-2-b": "hit" })
      // The file the build read changes. A key made of `packages/a/**` would not: the step would hit, and pass stale.
      // The other package's step read neither file. Where its reads are recorded it is answered from the cache;
      // elsewhere it runs on every change.
      writeFileSync(join(root, "config/value"), "bad\n")
      expect(statuses("third")).toEqual({ "ci-1": "ran", "ci-2-a": "failed", "ci-2-b": observes ? "hit" : "ran" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("keeps a package step narrowed after a step that names what it reads and writes", () => {
    const step = (
      id: string,
      command: string,
      extra: { inputs: Array<string>; outputs?: Array<string>; from: string }
    ) => ({
      id,
      command,
      cwd: "",
      env: {},
      secrets: [],
      ...extra
    })
    const steps = [
      // The build names the file it reads and the directory it writes, which git ignores.
      step("ci:1", "mkdir -p packages/a/dist && cp config/value packages/a/dist/out", {
        inputs: ["config/**"],
        outputs: ["packages/a/dist/**"],
        from: "ci:1"
      }),
      step("ci:2:a", "grep -q good packages/a/dist/out && grep -q source packages/a/src.txt", {
        inputs: ["packages/a/**"],
        from: "ci:2"
      }),
      step("ci:2:b", "grep -q source packages/b/src.txt", { inputs: ["packages/b/**"], from: "ci:2" })
    ]
    const root = repository(document([{ ...job("ci", []), steps }]), {
      "config/value": "good\n",
      "docs/guide.md": "x\n",
      "packages/a/.gitignore": "dist\n",
      "packages/a/src.txt": "source\n",
      "packages/b/src.txt": "source\n"
    })
    try {
      expect(plan(root).map((target) => [target.label, target.cacheable, target.dependencies])).toEqual([
        [`${prefix}ci-1`, false, []],
        [`${prefix}ci-2-a`, true, [`${prefix}ci-1`]],
        [`${prefix}ci-2-b`, true, [`${prefix}ci-1`]]
      ])
      // Running needs a machine that can confine a target to its declared reads.
      if (!confines) return
      const statuses = (name: string) => Object.fromEntries(execute(root, name).statuses)
      // Held to `packages/a/**`, the step still reads `dist/out`: it is an output of the target it depends on.
      expect(statuses("first")).toEqual({ "ci-1": "ran", "ci-2-a": "ran", "ci-2-b": "ran" })
      expect(statuses("second")).toEqual({ "ci-1": "ran", "ci-2-a": "hit", "ci-2-b": "hit" })
      // A file no step names: the package steps stay narrowed, so neither runs again.
      writeFileSync(join(root, "docs/guide.md"), "changed\n")
      expect(statuses("third")).toEqual({ "ci-1": "ran", "ci-2-a": "hit", "ci-2-b": "hit" })
      // A file one package step reads: only that step runs again.
      writeFileSync(join(root, "packages/b/src.txt"), "source again\n")
      expect(statuses("fourth")).toEqual({ "ci-1": "ran", "ci-2-a": "hit", "ci-2-b": "ran" })
      // The file the build reads: its key is in the key of both package steps, so both run again, and the one
      // that reads what the build wrote fails. Neither replays its old pass.
      writeFileSync(join(root, "config/value"), "bad\n")
      expect(statuses("fifth")).toEqual({ "ci-1": "ran", "ci-2-a": "failed", "ci-2-b": "ran" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 2 * slow)

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
    // The step runs on Linux runners GitHub hosts only, before the targets, and is a script bash reads.
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(steps.findIndex((step) => step["run"]?.includes("smthrs ci")))
    expect(steps[install]?.["if"]).toBe("runner.os == 'Linux' && runner.environment == 'github-hosted'")
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

  it("runs each matrix variant on its own machine, and never replays one version's result for another", () => {
    const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"
    const path = ".github/workflows/ci.yml"
    const workflow = `
on: push
jobs:
  lint:
    runs-on: ${runner}
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: "true"
  test:
    needs: lint
    runs-on: ${runner}
    strategy: { matrix: { node: [18, 20] } }
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: "\${{ matrix.node }}" }
      - run: "true"
`
    // The whole way from the workflow a person wrote: the importer, the CI rule and the generator.
    const read = assemble("example/real", "0000000000000000000000000000000000000005", [readWorkflow(path, workflow)])
    const root = repository(ci(read), { [path]: workflow })
    try {
      // `test` does not depend on `lint`: running it must not run `lint` under the wrong version.
      expect(plan(root).map((target) => [target.label, target.dependencies])).toEqual([
        [`${prefix}ci.yml-lint-1`, []],
        [`${prefix}ci.yml-test-1--18`, []],
        [`${prefix}ci.yml-test-1--20`, []]
      ])
      const generated = parseYaml(readFileSync(join(root, workflowPath), "utf8")) as {
        readonly jobs: {
          readonly ci: {
            readonly strategy: { readonly matrix: { readonly include: ReadonlyArray<Record<string, string | number>> } }
            readonly steps: ReadonlyArray<{ readonly run?: string }>
          }
        }
      }
      const { include } = generated.jobs.ci.strategy.matrix
      expect(include.map((leg) => [leg["tools"], leg["version-node"]])).toEqual([
        ["node 18", 18],
        ["node 20", 20],
        ["node 22", 22]
      ])
      // The workflow's own command, as a runner would run it for each machine.
      const command = generated.jobs.ci.steps.flatMap((step) =>
        step.run?.includes(" smthrs ci ") ? [step.run] : []
      )[0] as string
      const selection = /\$\(sed .*\)/.exec(command)?.[0] as string
      const runLeg = (leg: Record<string, string | number>, name: string) => {
        const script = `set -- ${selection.replace("${{ matrix.leg }}", String(leg["leg"]))}; printf '%s\n' "$@"`
        const labels = run(root, "bash", ["-c", script]).stdout.trim().split("\n")
        const resultsFile = join(stateOf(root), `${name}.json`)
        const outcome = run(root, process.execPath, [
          cli,
          "ci",
          ...labels,
          "--jobs",
          "1",
          "--cache-dir",
          stateOf(root),
          "--results-file",
          resultsFile
        ])
        expect(outcome.status, `${outcome.stdout}${outcome.stderr}`).toBe(0)
        const { results } = JSON.parse(readFileSync(resultsFile, "utf8")) as {
          readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
        }
        return results.map((result) => [result.label, result.status])
      }
      const [node18, node20, node22] = include as [
        Record<string, string>,
        Record<string, string>,
        Record<string, string>
      ]
      expect(runLeg(node18, "leg-18")).toEqual([[`${prefix}ci.yml-test-1--18`, "ran"]])
      // One cache directory, the same command: only the versions in the text differ.
      expect(runLeg(node20, "leg-20")).toEqual([[`${prefix}ci.yml-test-1--20`, "ran"]])
      expect(runLeg(node22, "leg-22")).toEqual([[`${prefix}ci.yml-lint-1`, "ran"]])
      expect(runLeg(node18, "leg-18-again")).toEqual([[`${prefix}ci.yml-test-1--18`, "hit"]])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)

  it("replays a verdict in a fresh checkout that restored the workflow's cache", () => {
    const inventory = document([job("check", ["grep -q source input.txt"])])
    const sources = { "input.txt": "source\n" }
    const first = repository(inventory, sources)
    const second = repository(inventory, sources)
    const without = repository(inventory, sources)
    try {
      expect(execute(first, "first").statuses.get("check-1")).toBe("ran")
      // The entries alone, without the content store that holds each step's record of what it read: the step runs.
      cpSync(join(stateOf(first), "cache"), join(stateOf(without), "cache"), { recursive: true })
      expect(execute(without, "without").statuses.get("check-1")).toBe("ran")
      // What `actions/cache` saves on one runner and restores on the next: the results, from outside the checkout.
      for (const kept of ["cache", contentStore]) {
        cpSync(join(stateOf(first), kept), join(stateOf(second), kept), { recursive: true })
      }
      expect(execute(second, "second").statuses.get("check-1")).toBe("hit")
    } finally {
      rmSync(without, { recursive: true, force: true })
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  }, slow)
})
