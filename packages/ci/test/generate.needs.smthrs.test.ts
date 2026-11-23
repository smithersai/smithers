/**
 * A step held to its files never reads what a job it `needs` wrote.
 *
 * GitHub jobs run on separate machines, so the first step of a job is held to
 * the files it names whatever jobs it `needs`: it starts from a fresh
 * checkout, not from what the needed job left. The needed job's targets run
 * on a machine of their own, so a file they rewrite is rewritten in their
 * copy, and the step is tested from the file as the commit has it.
 *
 * Real git repositories, the real `smthrs`, the real read sandbox.
 */
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Ci, Inventory as InventoryDocument, Job } from "../src/contract/Inventory.vibe"
import { files } from "../src/generate/index.vibe"
import { workspacePath } from "../src/generate/Render.ts"

const cli = fileURLToPath(new URL("../../smithers/bin/smithers.mjs", import.meta.url))
const slow = 600_000
const prefix = "//:"

/** True when this machine can hold a target to its declared reads: bubblewrap on Linux, seatbelt on macOS. */
const confines = process.platform === "darwin" || spawnSync("bwrap", ["--version"]).status === 0

const run = (cwd: string, command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** A real git repository holding `sources` and the files generated for `document`. */
const repository = (document: InventoryDocument, sources: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-needs-"))
  expect(run(root, "git", ["init", "-q", "."]).status).toBe(0)
  const generated = Effect.runSync(files(document as Ci))
  const all = [...Object.entries(sources), ...generated.map((file) => [file.path, file.content] as const)]
  for (const [path, content] of [[".gitignore", ".flows\nlocal\n"] as const, ...all]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** Runs every target and returns each one's status and the run's output. */
const execute = (root: string, name: string) => {
  const resultsFile = join(root, ".flows", `${name}.json`)
  const result = run(root, process.execPath, [cli, "ci", "//...", "--jobs", "1", "--results-file", resultsFile])
  const record = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  return {
    statuses: Object.fromEntries(record.results.map((target) => [target.label.slice(prefix.length), target.status])),
    output: result.output
  }
}

const job = (id: string, steps: Job["steps"], needs: ReadonlyArray<string> = []): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [...needs],
  triggers: ["push"],
  matrix: [],
  steps,
  unsupported: []
})

describe("the first step of a job that needs another job", () => {
  it.runIf(confines)("is tested from the file as the commit has it, whatever that job wrote to it", () => {
    const inventory: InventoryDocument = {
      version: 1,
      repository: "example/needs",
      commit: "0000000000000000000000000000000000000005",
      toolchains: [],
      jobs: [
        // Its first step rewrites a file the next job is tested from. It names no outputs, so nobody knows what
        // it wrote but the record of its run.
        job("generate", [
          { id: "generate:1", command: "cat config.txt > src/a.txt", cwd: "", env: {}, secrets: [] },
          { id: "generate:2", command: "grep -q two src/a.txt", cwd: "", env: {}, secrets: [] }
        ]),
        job("check", [{
          id: "check:1",
          command: "grep -q one src/a.txt",
          cwd: "",
          env: {},
          secrets: [],
          inputs: ["src/**"]
        }], ["generate"])
      ]
    }
    const root = repository(inventory, { "config.txt": "two\n", "src/a.txt": "one\n" })
    try {
      expect(run(root, "git", ["add", "-A"]).status).toBe(0)
      expect(
        run(root, "git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "one"])
          .status
      ).toBe(0)
      // The step is held to the files it names, and waits for the last step of the job it needs.
      const declared = readFileSync(join(root, workspacePath), "utf8")
      expect(declared).toContain(`data: [S.glob("//src/**"), step1]`)
      // The needed job runs on a machine of its own.
      expect(declared).toContain(`machine: "generate"`)
      const checked = (name: string) => {
        const { statuses, output } = execute(root, name)
        // The needed job passes, run or answered from its records: nothing it read changes here.
        expect(["ran", "hit"], output).toContain(statuses["generate-1"])
        expect(["ran", "hit"], output).toContain(statuses["generate-2"])
        return statuses["check-1"]
      }
      // `generate` writes "two" into its own copy of the file, and its second step finds it there. `check` reads
      // "one", as it does on a runner of its own.
      expect(checked("first")).toBe("ran")
      expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("one\n")
      expect(checked("second")).toBe("hit")
      // The commit's own file changes: the step is tested again, and fails as it would in CI.
      writeFileSync(join(root, "src/a.txt"), "three\n")
      expect(checked("third")).toBe("failed")
      writeFileSync(join(root, "src/a.txt"), "one\n")
      expect(checked("fourth")).toBe("hit")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)
})
