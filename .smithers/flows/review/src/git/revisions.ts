import { join } from "node:path"
import { io, runIo } from "../io.ts"
import { runCommand } from "./runCommand.ts"
import { runGit } from "./runGit.ts"

const DIFF_CONTEXT_LINES = 3

/**
 * Reads recorded revisions in the repository's own tool: jj where the
 * directory holds `.jj`, Git otherwise. A jj workspace beside its repository
 * has no `.git`, so commit and range reviews there can only read through jj;
 * a colocated repository reads through jj too, so a review takes the same
 * revisions its author's tool names.
 *
 * Every revision a caller passes is user text. Git reads it after
 * `--end-of-options`; jj reads it as an `=`-joined option value, so a ref
 * such as `--config=...` is a revset that fails to parse, never an option.
 *
 * @since 1.0.0
 * @category models
 */
export interface Revisions {
  /** The full commit id `rev` names; refuses a revision naming no commit or several. */
  readonly pin: (rev: string) => Promise<string>
  /** A commit's first parent, or `null` for a root commit. */
  readonly parent: (commit: string) => Promise<string | null>
  /** Where `to` forked from `from`: Git's merge-base, jj's `fork_point`. */
  readonly forkPoint: (from: string, to: string) => Promise<string>
  /** A file's text at a commit, or `null` when no file is there. */
  readonly fileAt: (commit: string, path: string) => Promise<string | null>
  /** One commit's change, as a Git-format diff. */
  readonly commitDiff: (commit: string) => Promise<string>
  /** The change from `base` to `to`, as a Git-format diff. */
  readonly rangeDiff: (base: string, to: string) => Promise<string>
}

const git = (repoDir: string): Revisions => ({
  pin: async (rev) =>
    (await runGit(repoDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], 30_000)).trim(),
  parent: async (commit) => {
    const parent = await runCommand("git", ["rev-parse", "--verify", "--quiet", `${commit}^1^{commit}`], repoDir)
    return parent.exitCode === 0 ? parent.stdout.trim() : null
  },
  forkPoint: async (from, to) => {
    const base = (await runGit(repoDir, ["merge-base", "--end-of-options", from, to])).trim()
    if (!base) throw new Error(`Cannot find merge-base between ${from} and ${to}.`)
    return base
  },
  fileAt: async (commit, path) => {
    const entry = (await runGit(repoDir, ["ls-tree", "--end-of-options", commit, "--", path])).trim()
    const [, type, sha] = entry.split(/\s+/)
    if (type !== "blob" || !sha) return null
    return runGit(repoDir, ["cat-file", "blob", sha])
  },
  commitDiff: (commit) =>
    runGit(repoDir, ["show", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--end-of-options", commit]),
  rangeDiff: (base, to) =>
    runGit(repoDir, ["diff", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--end-of-options", base, to, "--"])
})

/**
 * Runs one jj command over recorded commits, throwing on a non-zero exit.
 * `--ignore-working-copy` keeps a read from snapshotting the working copy, so
 * `@` names the working-copy commit as last recorded.
 */
async function runJj(repoDir: string, args: Array<string>) {
  const result = await runCommand(
    "jj",
    ["--ignore-working-copy", "--color=never", "--no-pager", ...args],
    repoDir,
    120_000
  )
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `jj ${args.join(" ")} failed`)
  return result.stdout
}

const ids = (text: string) => text.split("\n").filter(Boolean)

const jj = (repoDir: string): Revisions => {
  // A jj file set; `root-file:` names one file from the workspace root, never a directory.
  const file = (path: string) => `root-file:${JSON.stringify(path)}`
  const pin = async (rev: string) => {
    const found = ids(
      await runJj(repoDir, ["log", "--no-graph", `--revisions=${rev}`, "--template", "commit_id ++ \"\\n\""])
    )
    if (found.length !== 1) throw new Error(`${rev} names ${found.length} commits; a review reads one.`)
    return found[0]!
  }
  return {
    pin,
    parent: async (commit) => {
      const [first] = ids(
        await runJj(repoDir, [
          "log",
          "--no-graph",
          `--revisions=${commit}`,
          "--template",
          "parents.map(|p| p.commit_id() ++ \"\\n\").join(\"\")"
        ])
      )
      return first ?? null
    },
    forkPoint: async (from, to) => pin(`fork_point(${await pin(from)} | ${await pin(to)})`),
    fileAt: async (commit, path) =>
      ids(await runJj(repoDir, ["file", "list", `--revision=${commit}`, "--", file(path)])).length === 0
        ? null
        : runJj(repoDir, ["file", "show", `--revision=${commit}`, "--", file(path)]),
    commitDiff: (commit) =>
      runJj(repoDir, ["diff", "--git", `--context=${DIFF_CONTEXT_LINES}`, `--revisions=${commit}`]),
    rangeDiff: (base, to) =>
      runJj(repoDir, ["diff", "--git", `--context=${DIFF_CONTEXT_LINES}`, `--from=${base}`, `--to=${to}`])
  }
}

/**
 * The {@link Revisions} reader for `repoDir`: jj when it holds `.jj`, Git otherwise.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function revisionsFor(repoDir: string): Promise<Revisions> {
  return await runIo(io().fs.exists(join(repoDir, ".jj"))) ? jj(repoDir) : git(repoDir)
}
