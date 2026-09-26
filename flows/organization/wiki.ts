/**
 * `wiki.commit`: the host commits what it wrote to the wiki's git
 * repository — receipts, documents, meeting notes and bookings under the
 * generated directory, hired profiles under `<rosterDir>/Specialists/`, and
 * the status page — and nothing else. It never pushes.
 *
 * The commit is limited to those paths (`git commit -- <paths>`), so the
 * owner's own edits elsewhere, staged or not, stay exactly as they were.
 * Hooks and signing are skipped: the commit is the host's record, made
 * unattended. A repository busy with another git command is left for the
 * next attempt.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import * as Config from "../../packages/smithers/agent/organization/src/Config.ts"

/** The wiki paths the host writes, relative to the root. */
export const hostPaths = (organization: Pick<Config.Organization, "rosterDir" | "wiki">): ReadonlyArray<string> => [
  organization.wiki.generatedDir.replace(/\/+$/, ""),
  `${organization.rosterDir.replace(/\/+$/, "")}/Specialists`,
  organization.wiki.statusFile
]

/** What one commit recorded. */
export interface Committed {
  readonly revision: string
  readonly files: ReadonlyArray<string>
  readonly message: string
}

const git = (root: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: env ?? process.env })

/** The files under `paths` git reports as changed, untracked ones included. */
export const changed = (root: string, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths])
  if (status.status !== 0) return []
  const files: Array<string> = []
  const fields = status.stdout.split("\0")
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    files.push(field.slice(3))
    // A rename carries its source path in the next field.
    if (field[0] === "R" || field[0] === "C") files.push(fields[++index]!)
  }
  return files.sort()
}

const brief = (names: ReadonlyArray<string>, max = 4) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max}`

/** The commit message: which runs, hires and pages the host recorded. */
export const message = (paths: ReadonlyArray<string>, files: ReadonlyArray<string>): string => {
  const [generated, specialists, status] = paths
  const under = (prefix: string | undefined) =>
    prefix === undefined
      ? []
      : [...new Set(files.filter((file) => file.startsWith(`${prefix}/`)).map((file) => file.slice(prefix.length + 1).split("/")[0]!))]
  const runs = under(generated)
  const hires = under(specialists).map((file) => file.replace(/\.md$/, ""))
  const parts = [
    ...(runs.length === 0 ? [] : [`runs ${brief(runs)}`]),
    ...(hires.length === 0 ? [] : [`specialists ${brief(hires)}`]),
    ...(status !== undefined && files.includes(status) ? ["status"] : [])
  ]
  return `organization: record ${parts.length === 0 ? `${files.length} file(s)` : parts.join("; ")}`
}

/** Committer used only when the repository names none. */
const fallbackIdentity = {
  GIT_AUTHOR_NAME: "Smithers organization host",
  GIT_AUTHOR_EMAIL: "organization@localhost",
  GIT_COMMITTER_NAME: "Smithers organization host",
  GIT_COMMITTER_EMAIL: "organization@localhost"
}

/**
 * Commits the host's changed files under `paths` in the wiki repository at
 * `root`. `undefined` when the root is not a git work tree or nothing under
 * the paths changed; throws with git's first line when the commit fails.
 */
export const commit = (root: string, paths: ReadonlyArray<string>): Committed | undefined => {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") return undefined
  const files = changed(root, paths)
  if (files.length === 0) return undefined
  const present = paths.filter((path) => existsSync(join(root, path)) || git(root, ["ls-files", "--", path]).stdout !== "")
  const env = git(root, ["config", "user.email"]).stdout.trim() === ""
    ? { ...process.env, ...fallbackIdentity }
    : process.env
  const text = message(paths, files)
  const add = git(root, ["add", "-A", "--", ...present], env)
  if (add.status !== 0) throw new Error(`git add: ${add.stderr.trim().split("\n")[0]}`)
  const made = git(
    root,
    ["-c", "commit.gpgsign=false", "commit", "--no-verify", "--quiet", "-m", text, "--", ...present],
    env
  )
  if (made.status !== 0) throw new Error(`git commit: ${(made.stderr || made.stdout).trim().split("\n")[0]}`)
  return { revision: git(root, ["rev-parse", "HEAD"]).stdout.trim(), files, message: text }
}

/**
 * The host's paths under `root` when its organization page asks for
 * `wiki.commit`; `undefined` otherwise, or when the page does not parse.
 */
export const committedPaths = (root: string): ReadonlyArray<string> | undefined => {
  const file = join(root, Config.defaultOrganizationFile)
  if (!existsSync(file)) return undefined
  const parsed = Effect.runSync(Effect.result(Config.parseOrganization(Config.defaultOrganizationFile, readFileSync(file, "utf8"))))
  return parsed._tag === "Success" && parsed.success.wiki.commit ? hostPaths(parsed.success) : undefined
}

/** How often a serving host commits what it wrote. */
export const interval = "30 seconds"

/**
 * The serving host's committer: commits every {@link interval} and once
 * more when the host stops. A failed commit is logged and retried on the
 * next tick; it never stops the host.
 */
export const committer = (root: string, paths: ReadonlyArray<string>, log: (line: string) => void) => {
  const once = Effect.sync(() => {
    try {
      const made = commit(root, paths)
      if (made !== undefined) log(`wiki ${made.revision.slice(0, 12)}: ${made.message}`)
    } catch (error) {
      log(`wiki commit failed: ${(error as Error).message}`)
    }
  })
  return Effect.addFinalizer(() => once).pipe(
    Effect.andThen(once.pipe(Effect.delay(interval), Effect.forever))
  )
}
