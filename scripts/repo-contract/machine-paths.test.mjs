/**
 * No operator rig may name one machine's home directory.
 *
 * `evals/swebench` is operator-run tooling that arrived from another checkout,
 * and it arrived carrying that checkout's absolute directory — `/Users`, an
 * operator's name, `flows/flows` — in a committed measurement record. A path
 * like that is invisible until somebody else runs the rig: it resolves to
 * nothing on their machine, and the record it sits in claims to describe a
 * checkout that is not the one under test.
 *
 * The gate's own prose therefore names no such path either. Writing the example
 * out is what tripped it the first time it ran over `scripts/`.
 *
 * So the gate is a class, not one file. Every tracked file under `evals/`,
 * `scripts/` and every package's `test/faults` tree is read, and any absolute
 * home-directory path in it fails. `git ls-files` is the file list, because the
 * untracked working files a wave leaves behind — pinned subjects, extracted
 * testbeds, virtualenvs — legitimately hold absolute paths and are gitignored
 * for exactly that reason.
 *
 * It covers the fault trees because the same mistake landed there under its own
 * name, while they were still a standalone `e2e/` member: a debug probe
 * committed with the author's checkout path in a dynamic `import`, which runs
 * on one machine and throws on every other. The cases moved into the packages
 * they test; the class of mistake did not move with them.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

/**
 * A home directory belonging to a person: `/Users/<name>/` on macOS and
 * `/home/<name>/` on Linux. The trailing segment is required so that a
 * reference to `/home` or `/Users` as a concept does not trip the gate.
 */
const homePath = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//

/** The paths this gate reads, as `git ls-files` pathspecs. */
// `git ls-files` pathspecs. `*` crosses directory separators here, and the
// trailing `/*` is what makes the wildcard form match files rather than a
// directory name, so one entry reaches every `test/faults` tree whatever depth
// its package sits at. Packages nest — a granular package lives inside the
// product package it belongs to — and a depth-bound spelling would silently
// stop reading most of the matrix.
const scanned = ["evals", "scripts", "packages/*/test/faults/*"]

/** Every tracked file under {@link scanned}, as repository-relative paths. */
const tracked = () => {
  const result = spawnSync("git", ["ls-files", "--", ...scanned], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`)
  return result.stdout.split("\n").filter((line) => line.length > 0)
}

/**
 * Recorded material, exempt because rewriting it would falsify a record rather
 * than fix a path.
 *
 * - `evals/swebench/reports/` and `evals/swebench/archive/` are wave write-ups.
 *   They quote the commands an operator ran on the machine that ran them, and
 *   they are read by people, never by the rig.
 * - `evals/authoring/data/` is a captured supervised-fine-tuning corpus. Its
 *   assistant turns are transcripts; editing a path inside one would change
 *   what a model was shown.
 */
const isRecorded = (path) =>
  path.startsWith("evals/swebench/reports/")
  || path.startsWith("evals/swebench/archive/")
  || path.startsWith("evals/authoring/data/")

describe("the rigs and gates outside the packages", () => {
  it("has files to check", () => {
    assert.ok(tracked().length > 0, `git ls-files found no tracked file under ${scanned.join(", ")}`)
  })

  it("names no machine's home directory in a file the rig reads", () => {
    const offenders = []
    for (const path of tracked()) {
      if (isRecorded(path)) continue
      let content
      try {
        content = readFileSync(join(root, path), "utf8")
      } catch {
        continue
      }
      for (const [index, line] of content.split("\n").entries()) {
        const found = homePath.exec(line)
        if (found !== null) offenders.push(`${path}:${index + 1} ${found[0]}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a rig that hard-codes one machine's home directory resolves to nothing on anybody else's:\n  "
        + offenders.join("\n  ")
    )
  })
})
