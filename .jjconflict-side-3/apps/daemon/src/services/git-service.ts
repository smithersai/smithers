import { existsSync, readdirSync } from "node:fs"

import { HttpError } from "@/utils/http-error"

function runGit(args: string[], cwd?: string) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()

  if (result.exitCode !== 0) {
    throw new HttpError(400, stderr || `git ${args.join(" ")} failed`)
  }

  return stdout
}

export function isGitRepository(repoPath: string) {
  return existsSync(repoPath) && existsSync(`${repoPath}/.git`)
}

export function assertDirectoryUsable(targetPath: string) {
  if (!existsSync(targetPath)) {
    return
  }

  const entries = readdirSync(targetPath)
  if (entries.length > 0) {
    throw new HttpError(409, `Target path already exists and is not empty: ${targetPath}`)
  }
}

export function cloneRepository(repoUrl: string, targetPath: string) {
  runGit(["clone", repoUrl, targetPath])
}

export function initRepository(targetPath: string) {
  runGit(["init"], targetPath)
}

export function getCurrentBranch(repoPath: string) {
  try {
    return runGit(["branch", "--show-current"], repoPath) || undefined
  } catch {
    return undefined
  }
}

export function getOriginUrl(repoPath: string) {
  try {
    return runGit(["remote", "get-url", "origin"], repoPath) || undefined
  } catch {
    return undefined
  }
}
