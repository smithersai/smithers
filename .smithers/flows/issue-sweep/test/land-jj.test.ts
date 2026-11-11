/**
 * Landing helpers against real processes: jj prints paths relative to the
 * process's directory, and a landing must still see repository paths; target
 * indexing runs the change's declarations, so it must run sandboxed.
 */
import { Effect } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { changedFiles, indexTargets, liveChecks } from "../land.ts"

test("changedFiles names repository-relative paths whatever the process's directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-land-"))
  try {
    const jj = (...args: Array<string>) =>
      execFileSync("jj", ["-R", root, "--config", "user.name=t", "--config", "user.email=t@t", ...args], {
        encoding: "utf8",
        cwd: tmpdir()
      })
    execFileSync("jj", ["git", "init", root], { cwd: tmpdir() })
    mkdirSync(join(root, "packages/smithers/flows/patterns/src"), { recursive: true })
    writeFileSync(join(root, "packages/smithers/flows/patterns/src/Burndown.ts"), "export {}\n")
    jj("describe", "-m", "change")
    const change = jj("log", "--no-graph", "-r", "@", "-T", "change_id").trim()
    // From another directory jj alone prints the path relative to that directory.
    assert.notEqual(jj("diff", "--name-only", "-r", change).trim(), "packages/smithers/flows/patterns/src/Burndown.ts")

    const files = await Effect.runPromise(changedFiles(root, change))

    assert.deepEqual(files, ["packages/smithers/flows/patterns/src/Burndown.ts"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("target indexing evaluates the change's declarations only inside codex sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-index-"))
  const bin = join(root, "bin")
  const path = process.env.PATH
  try {
    mkdirSync(bin)
    // pnpm on the host would evaluate the change's WORKSPACE.ts and PACKAGE.ts with the operator's authority.
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\ntouch "${root}/host-ran"\nprintf '{"targets":[]}'\n`, { mode: 0o755 })
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nprintf '%s' "$*" > "${root}/sandbox-ran"\nprintf '{"targets":[{"label":"//a:test","kinds":["test"],"inputs":[]}]}'\n`,
      { mode: 0o755 }
    )
    process.env.PATH = `${bin}:${path}`

    const targets = await Effect.runPromise(indexTargets(root))

    assert.equal(liveChecks.index, indexTargets)
    assert.deepEqual(targets.map((target) => target.label), ["//a:test"])
    assert.equal(existsSync(join(root, "host-ran")), false)
    const argv = readFileSync(join(root, "sandbox-ran"), "utf8")
    assert.ok(argv.startsWith(`sandbox -P :workspace -C ${root} `), argv)
    assert.ok(argv.endsWith(" -- pnpm exec smthrs index //... --format json"), argv)
  } finally {
    process.env.PATH = path
    rmSync(root, { recursive: true, force: true })
  }
})

test("target indexing that exits non-zero fails the landing", async () => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-index-"))
  const path = process.env.PATH
  try {
    writeFileSync(join(root, "codex"), "#!/bin/sh\necho 'PACKAGE.ts: boom' >&2\nexit 3\n", { mode: 0o755 })
    process.env.PATH = `${root}:${path}`

    const result = await Effect.runPromise(Effect.result(indexTargets(root)))

    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.message, "smthrs index: exit 3: PACKAGE.ts: boom")
  } finally {
    process.env.PATH = path
    rmSync(root, { recursive: true, force: true })
  }
})
