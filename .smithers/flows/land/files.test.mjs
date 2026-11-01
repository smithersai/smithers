import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, linkSync, symlinkSync, readdirSync, chmodSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { jj } from "./numbering.mjs"
import { sourcePath, writeSource } from "./files.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "devx-source-writes-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  jj(root, ["git", "init", "."])
  return root
}

test("atomic source writes break hard links, preserve executable mode and leave no tracked scratch", (t) => {
  const root = fixture(t)
  writeFileSync(join(root, "other.txt"), "other tree bytes\n")
  chmodSync(join(root, "other.txt"), 0o755)
  linkSync(join(root, "other.txt"), join(root, "ours.txt"))
  writeSource(root, "ours.txt", "our new bytes\n")
  assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "other tree bytes\n")
  assert.equal(readFileSync(join(root, "ours.txt"), "utf8"), "our new bytes\n")
  assert.equal(statSync(join(root, "ours.txt")).mode & 0o777, 0o755)
  assert.deepEqual(readdirSync(join(root, ".jj/agent-writes")), [])
  assert.equal(jj(root, ["file", "list"]).includes("agent-writes"), false)
  writeSource(root, "new.txt", "new\n")
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "new\n")
})

test("guards reject traversal and links in the leaf or an ancestor without changing their targets", (t) => {
  const root = fixture(t)
  mkdirSync(join(root, "other"))
  writeFileSync(join(root, "other/file.txt"), "retained\n")
  symlinkSync(join(root, "other/file.txt"), join(root, "leaf.txt"))
  symlinkSync(join(root, "other"), join(root, "parent"))
  assert.throws(() => writeSource(root, "leaf.txt", "bad"), /symlink/)
  assert.throws(() => writeSource(root, "parent/file.txt", "bad"), /symlink/)
  assert.equal(sourcePath(root, "leaf.txt", true), join(root, "leaf.txt"))
  for (const path of ["../outside", "/absolute", "a/../b", "a//b", "./file"]) assert.throws(() => sourcePath(root, path), /Invalid/)
  assert.equal(readFileSync(join(root, "other/file.txt"), "utf8"), "retained\n")
  assert.throws(() => writeSource(root, "missing/directory.txt", "new"), /ENOENT/)
  assert.deepEqual(readdirSync(join(root, ".jj/agent-writes")), [])
})
