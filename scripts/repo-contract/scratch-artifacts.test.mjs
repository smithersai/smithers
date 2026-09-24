/**
 * No app ships a run's scratch output.
 *
 * An enrollment sweep left its shell exit codes (`.enrollment-*.exit`) and a
 * 444 KB macOS `sample` trace of a bun process in `apps/app`, and one exit code
 * in `apps/server`. Nothing read them, yet every clone and every packed app
 * carried them, the trace with its local pids and paths.
 *
 * The gate is a class, not those files: any tracked file under `apps/` whose
 * name marks it as a captured exit code or enrollment scratch fails. The
 * matching names are gitignored at the root, so the next sweep writes them
 * where they stay local.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

/**
 * Every tracked path under `apps/`. A jj checkout is read from its last
 * snapshot, without snapshotting edits; a plain Git checkout (CI) from its
 * index.
 */
const tracked = (repositoryRoot = root, run = spawnSync) => {
  const jj = existsSync(join(repositoryRoot, ".jj"))
  const command = jj ? "jj" : "git"
  const args = jj ? ["file", "list", "--ignore-working-copy", "apps"] : ["ls-files", "--", "apps"]
  const result = run(command, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, `${command} inventory failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.split("\n").filter((path) => path.startsWith("apps/"))
}

/** A captured shell exit code, or anything an enrollment sweep wrote beside it. */
const isScratch = (path) => {
  const name = basename(path)
  return name.startsWith(".enrollment-") || name.endsWith(".exit")
}

describe("the apps' tracked files", () => {
  it("has files to check", () => {
    assert.ok(tracked().length > 0, "VCS inventory found no tracked file under apps/")
  })

  it("carries no run scratch", () => {
    const offenders = tracked().filter(isScratch)
    assert.deepEqual(offenders, [], "run scratch is tracked and ships with the app:\n  " + offenders.join("\n  "))
  })
})

it("reads jj when the checkout has one, Git otherwise, and flags only scratch names", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scratch-artifacts-inventory-"))
  try {
    mkdirSync(join(fixture, ".git"))
    assert.deepEqual(tracked(fixture, (command, args, options) => {
      assert.equal(command, "git")
      assert.deepEqual(args, ["ls-files", "--", "apps"])
      assert.equal(options.cwd, fixture)
      return { status: 0, stdout: "apps/app/package.json\n", stderr: "" }
    }), ["apps/app/package.json"])
    mkdirSync(join(fixture, ".jj"))
    const files = tracked(fixture, (command, args) => {
      assert.equal(command, "jj")
      assert.deepEqual(args, ["file", "list", "--ignore-working-copy", "apps"])
      return {
        status: 0,
        stdout: "apps/app/.enrollment-e2e.exit\napps/app/.enrollment-sample.txt\napps/server/probe.exit\napps/app/src/exit.ts\napps/app/.gitignore\n",
        stderr: ""
      }
    })
    assert.deepEqual(files.filter(isScratch), [
      "apps/app/.enrollment-e2e.exit",
      "apps/app/.enrollment-sample.txt",
      "apps/server/probe.exit"
    ])
    assert.throws(() => tracked(fixture, () => ({ status: 1, stdout: "", stderr: "inventory unavailable" })), /inventory unavailable/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
