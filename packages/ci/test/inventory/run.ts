import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type Job, script, shell, withVariant } from "../../src/contract/Inventory.ts"
import type { Facts } from "../../src/inventory/Contexts.ts"
import { readWorkflow } from "../../src/inventory/GithubActions.ts"

/** A repository made for one test, with the directory its jobs keep their state in. */
export interface Repository {
  readonly root: string
  readonly temp: string
  readonly facts: Facts
  /** Removes the repository and its state. */
  readonly remove: () => void
}

const git = (root: string, ...args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    encoding: "utf8"
  })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * Writes `files` into a new directory and commits them on the branch `main`, after one earlier commit, so the
 * commit under replay has a parent as a merged pull request has.
 */
export const repository = (files: Readonly<Record<string, string>>): Repository => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-workflow-"))
  const temp = mkdtempSync(join(tmpdir(), "smithers-ci-state-"))
  git(root, "init", "--quiet", "--initial-branch=main")
  git(root, "commit", "--quiet", "--allow-empty", "-m", "first")
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "-m", "second")
  return {
    root,
    temp,
    facts: { repository: "acme/widgets", defaultBranch: "main", read: (path) => files[path] },
    remove: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(temp, { recursive: true, force: true })
    }
  }
}

/** The commit a repository is at, and its first parent. */
export const commits = (repo: Repository): { readonly head: string; readonly parent: string } => ({
  head: git(repo.root, "rev-parse", "HEAD"),
  parent: git(repo.root, "rev-parse", "HEAD^")
})

/** The jobs of one workflow file of a repository. */
export const jobsOf = (repo: Repository, file: string): ReadonlyArray<Job> =>
  readWorkflow(file, (repo.facts.read as (path: string) => string)(file), repo.facts).jobs

/** How one step ended when it was run. */
export interface Ran {
  readonly id: string
  readonly status: number | null
  readonly output: string
}

/**
 * Runs a job's steps in order as the baseline does: each under the contract's shell, in the step's directory, with
 * the step's variables and little else. Stops at the first step that fails.
 */
export const runJob = (
  repo: Repository,
  job: Job,
  variant: Readonly<Record<string, string>> = {},
  path = process.env["PATH"] ?? ""
): ReadonlyArray<Ran> => {
  const ran: Array<Ran> = []
  for (const step of job.steps.map((entry) => withVariant(entry, variant))) {
    const result = spawnSync(shell[0], [...shell.slice(1), script(step)], {
      cwd: join(repo.root, step.cwd),
      env: { PATH: path, HOME: repo.temp, TMPDIR: repo.temp, ...step.env },
      encoding: "utf8"
    })
    ran.push({ id: step.id, status: result.status, output: `${result.stdout}${result.stderr}` })
    if (result.status !== 0) break
  }
  return ran
}
