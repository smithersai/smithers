/**
 * A job whose step starts a server in the background for the steps after it, written by the real program. On a
 * GitHub runner such a program lives until the job ends. Where it cannot be kept that long the job is not turned
 * into build steps: it stays in the repository's own workflow, and the notes name it, its step and why.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { notesPath, workspacePath } from "../../src/generate/Render.ts"
import { bin, commit, git, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

/** The reviewer's shape: `split` starts a server in one step and asks it in the next; `same` does both in one. */
const workflow = `name: ci
on: [push, pull_request]
jobs:
  split:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 -m http.server 8767 --bind 127.0.0.1 --directory site > /dev/null 2>&1 &
      - run: |
          for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:8767/x.txt > got.txt && break; sleep 0.5; done
          grep -qx ok got.txt
  same:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          python3 -m http.server 8768 --bind 127.0.0.1 --directory site > /dev/null 2>&1 &
          for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:8768/x.txt > got.txt && break; sleep 0.5; done
          kill %1; grep -qx ok got.txt
`

describe("apply, with a job whose step leaves a server running for the next step", () => {
  it("keeps the job out of the build steps and names it, its step and why in the notes", async () => {
    const root = temporary("apply-left-running")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "site/x.txt": "ok\n" })

    const outcome = await spawn(bin, ["apply"], root)
    expect(outcome.code, outcome.stderr).toBe(0)
    const notes = readFileSync(join(root, notesPath), "utf8")
    expect(notes).toContain(
      "- ci.yml:split: not in this workflow: leaves a program running for its later steps, which this machine " +
        "cannot keep until the job ends: \"Run python3 -m http.server 8767 --bind 127.0.0.1 --director…\" leaves " +
        "python3 running; the job stays in your CI as it is\n"
    )
    expect(notes).not.toContain("ci.yml:same: not in this workflow")
    const declared = readFileSync(join(root, workspacePath), "utf8")
    expect(declared).toContain("ci.yml-same-1")
    expect(declared).not.toContain("ci.yml-split")
    // The repository's own workflow is as it was: the job runs there.
    expect(git(root, "status", "--porcelain", "--", ".github/workflows/ci.yml")).toBe("")
  }, 180_000)
})
