import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { workflowPath, workspacePath } from "../src/generate/Render.ts"

const program = fileURLToPath(new URL("../bin/smithers-ci.mjs", import.meta.url))
const generated = [workflowPath, workspacePath]

const run = (cwd: string, command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** A real git repository whose CI is a Justfile, with one commit. */
const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-apply-twice-"))
  writeFileSync(join(root, "justfile"), "ci: test\n\ntest:\n\techo ok\n")
  for (
    const args of [
      ["init", "-q", "."],
      ["add", "--all"],
      ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "c"]
    ]
  ) expect(run(root, "git", args).status).toBe(0)
  return root
}

describe("the real program, with a file where its directory goes", () => {
  it("says that .smithers is not a directory, and writes nothing", () => {
    const root = repository()
    try {
      writeFileSync(join(root, ".smithers"), "a file\n")
      for (
        const args of [["add", "--all"], ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "f"]]
      ) {
        expect(run(root, "git", args).status).toBe(0)
      }
      const outcome = run(root, process.execPath, [program, "apply"])
      expect(outcome.status, outcome.output).toBe(3)
      expect(outcome.output).toContain(`.smithers is not a directory, so ${workspacePath} cannot be written`)
      expect(outcome.output).not.toContain("already builds with Smithers build")
      expect(run(root, "git", ["status", "--porcelain"]).output).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})

describe("the real program, applied twice", () => {
  it("writes byte-equal files the second time, with its own workflow in the tree", () => {
    const root = repository()
    try {
      const apply = (): Readonly<Record<string, string>> => {
        const outcome = run(root, process.execPath, [program, "apply"])
        expect(outcome.status, outcome.output).toBe(0)
        return Object.fromEntries(generated.map((path) => [path, readFileSync(join(root, path), "utf8")]))
      }
      const first = apply()
      // The second run reads an inventory that holds the first run's workflow: its Node and its `just`.
      const inventory = run(root, process.execPath, [program, "inventory", "--json"])
      expect(inventory.output).toContain(`"source": ${JSON.stringify(workflowPath)}`)
      expect(apply()).toEqual(first)
      // The workflow installs the Node smithers-ci runs on and checks the generated files, before the repository's
      // tools. The files apply wrote twice pass that check.
      expect(first[workflowPath]).toContain(
        `node-version: 24\n      - name: Generated files are up to date\n        run: >-\n          npx --yes --package=smithers-ci@`
      )
      expect(first[workflowPath]).toMatch(/ apply --check\n      - uses: extractions\/setup-just@v3\n/)
      expect(run(root, process.execPath, [program, "apply", "--check"]).status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
