import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sourceRevision } from "./source-revision"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const jj = (root: string, ...args: string[]): string => {
  const result = Bun.spawnSync(["jj", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

test("packaged source revision follows content across jj's empty post-push working copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-matrix-revision-"))
  roots.push(root)
  jj(root, "git", "init", "--colocate")
  writeFileSync(join(root, "README"), "landed content\n")
  jj(root, "describe", "-m", "landed")
  const landed = jj(root, "log", "-r", "@", "--no-graph", "-T", "commit_id")
  jj(root, "new")
  expect(await sourceRevision(root)).toBe(landed)

  writeFileSync(join(root, "README"), "edited content\n")
  const edited = jj(root, "log", "-r", "@", "--no-graph", "-T", "commit_id")
  expect(edited).not.toBe(landed)
  expect(await sourceRevision(root)).toBe(edited)
// Several real jj processes initialize and snapshot a repository; this is not a 5 s latency contract.
}, 30_000)
