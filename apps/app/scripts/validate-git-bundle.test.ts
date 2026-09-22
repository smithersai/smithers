import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateGitBundle } from "./validate-git-bundle"

test("rejects a dangling relative Git symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-git-bundle-"))
  try {
    const exec = join(root, "libexec", "git-core")
    mkdirSync(exec, { recursive: true })
    symlinkSync("../../bin/git-shell", join(exec, "git-shell"))
    expect(() => validateGitBundle(root, [exec])).toThrow("Pinned Git symlink is dangling")
    mkdirSync(join(root, "bin"))
    writeFileSync(join(root, "bin", "git-shell"), "")
    expect(() => validateGitBundle(root, [exec])).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
