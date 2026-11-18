/**
 * A step held to its files is keyed on the files as they are when it starts.
 *
 * GitHub jobs run on separate machines, so the first step of a job is held to
 * the files it names whatever jobs it `needs`. The generated targets run in
 * one working tree, where the steps of those jobs ran before it and may have
 * rewritten one of its files. Smithers build measures a target again when it
 * starts, so the step is answered only by a run that read the same bytes.
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
import type { Ci, Inventory as InventoryDocument, Job } from "../src/contract/Inventory.ts"
import { files } from "../src/generate/index.ts"
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
  it.runIf(confines)("is never answered by a result for a file as it was before that job rewrote it", () => {
    const inventory: InventoryDocument = {
      version: 1,
      repository: "example/needs",
      commit: "0000000000000000000000000000000000000005",
      toolchains: [],
      jobs: [
        // Its first step writes a file the next job is tested from, out of a file git ignores: no key in the
        // plan holds what it writes. It always runs and names no outputs, so nobody knows what it wrote.
        job("generate", [
          { id: "generate:1", command: "cat local/config.txt > src/a.txt", cwd: "", env: {}, secrets: [] },
          { id: "generate:2", command: "true", cwd: "", env: {}, secrets: [] }
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
    const root = repository(inventory, { "local/config.txt": "one\n", "src/a.txt": "one\n" })
    try {
      // The step is held to the files it names, and waits for the last step of the job it needs.
      const declared = readFileSync(join(root, workspacePath), "utf8")
      expect(declared).toContain(`data: [S.glob("//src/**"), step1]`)
      const checked = (name: string) => {
        const { statuses, output } = execute(root, name)
        expect(statuses["generate-1"], output).toBe("ran")
        return statuses["check-1"]
      }
      expect(checked("first")).toBe("ran")
      expect(checked("second")).toBe("hit")
      // The plan measures src/a.txt holding "one"; `generate` then writes "two" into it.
      writeFileSync(join(root, "local/config.txt"), "two\n")
      expect(checked("third")).toBe("failed")
      // Nothing was stored for the failure.
      expect(checked("fourth")).toBe("failed")
      // A fresh checkout, and the job writes "one" again: the first run's result answers for those bytes.
      writeFileSync(join(root, "src/a.txt"), "one\n")
      writeFileSync(join(root, "local/config.txt"), "one\n")
      expect(checked("fifth")).toBe("hit")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, slow)
})
