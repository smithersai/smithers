import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { expect, it } from "vitest"
import { gitBinary, resolveGitBinary } from "./gitBinary.ts"

const name = process.platform === "win32" ? "git.exe" : "git"

it("does not mistake a directory for an installed Git binary", () => {
  const root = mkdtempSync(join(tmpdir(), "flows-git-directory-"))
  try {
    mkdirSync(join(root, name))
    expect(resolveGitBinary([join(root, "missing"), root].join(delimiter))).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(gitBinary === undefined)("finds Git after unusable PATH entries", () => {
  const root = mkdtempSync(join(tmpdir(), "flows-git-path-"))
  try {
    const directory = join(root, "directory")
    const denied = join(root, "denied")
    const installed = join(root, "installed")
    mkdirSync(join(directory, name), { recursive: true })
    mkdirSync(denied)
    mkdirSync(installed)
    const binary = join(installed, name)
    copyFileSync(gitBinary!, binary)
    copyFileSync(gitBinary!, join(denied, name))
    chmodSync(join(denied, name), 0o600)
    const entries = [join(root, "missing"), directory, ...(process.platform === "win32" ? [] : [denied]), installed]
    expect(resolveGitBinary(entries.join(delimiter))).toBe(binary)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
