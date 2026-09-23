/**
 * The files `@` offers: tracked and untracked-but-not-ignored files from git,
 * else `rg --files`, which also honors `.gitignore`. Read again at most once
 * every few seconds so a file the agent just wrote shows up.
 */
import { spawnSync } from "node:child_process"

const maxFiles = 20_000
const freshMs = 5_000

const run = (command: string, args: ReadonlyArray<string>, cwd: string): Array<string> | undefined => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined
  return result.stdout.split("\n").filter((line) => line !== "").slice(0, maxFiles)
}

export const list = (cwd: string): ReadonlyArray<string> =>
  run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], cwd) ?? run("rg", ["--files"], cwd) ?? []

/** `list`, cached for a few seconds. */
export const lister = (cwd: string, now: () => number = Date.now): (() => ReadonlyArray<string>) => {
  let cached: ReadonlyArray<string> = []
  let readAt = -Infinity
  return () => {
    if (now() - readAt > freshMs) {
      cached = list(cwd)
      readAt = now()
    }
    return cached
  }
}
