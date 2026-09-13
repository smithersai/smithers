import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const script = resolve(import.meta.dirname, "commit.mjs")
const command = (cwd, bin, args) => spawnSync(bin, args, { cwd, encoding: "utf8" })
const ok = (cwd, bin, args) => {
  const result = command(cwd, bin, args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
for (const vcs of ["git", "jj"]) {
  test(`${vcs}: commits all contributors, preserves main, ignores secrets, pushes only on request`, () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-commit-test-"))
    const remote = mkdtempSync(join(tmpdir(), "smithers-commit-remote-"))
    try {
      ok(directory, "git", ["init", "-b", "main"])
      ok(directory, "git", ["config", "user.name", "Commit test"])
      ok(directory, "git", ["config", "user.email", "test@example.com"])
      writeFileSync(join(directory, ".gitignore"), ".env\n")
      ok(directory, "git", ["add", ".gitignore"])
      ok(directory, "git", ["commit", "-m", "initial"])
      ok(remote, "git", ["init", "--bare", "-b", "main"])
      ok(directory, "git", ["remote", "add", "origin", remote])
      if (vcs === "jj") ok(directory, "jj", ["git", "init", "--colocate"])
      writeFileSync(join(directory, "first.txt"), "first contributor\n")
      writeFileSync(join(directory, "second.txt"), "second contributor\n")
      writeFileSync(join(directory, ".env"), "ignored test data\n")
      ok(directory, "node", [script, "--message", "test: both contributors"])
      assert.equal(ok(directory, "git", ["log", "main", "-1", "--format=%s"]), "test: both contributors")
      assert.match(ok(directory, "git", ["show", "main:first.txt"]), /first contributor/)
      assert.match(ok(directory, "git", ["show", "main:second.txt"]), /second contributor/)
      assert.equal(ok(directory, "git", ["ls-tree", "--name-only", "main", ".env"]), "")
      assert.equal(ok(remote, "git", ["for-each-ref", "refs/heads/main"]), "")
      const before = ok(directory, "git", ["rev-parse", "main"])
      ok(directory, "node", [script, "--push"])
      assert.equal(ok(remote, "git", ["rev-parse", "main"]), before)
      assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      assert.equal(readFileSync(join(directory, ".env"), "utf8"), "ignored test data\n")
      if (vcs === "jj") {
        ok(directory, "jj", ["new"])
        writeFileSync(join(directory, "third.txt"), "unlanded lineage\n")
        const refused = command(directory, "node", [script])
        assert.notEqual(refused.status, 0)
        assert.match(refused.stderr, /must be on main/)
        assert.equal(ok(directory, "git", ["rev-parse", "main"]), before)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })
}
