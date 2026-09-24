/**
 * Which revision a deploy may publish, and how the Cloudflare version names it.
 *
 * A real deploy ships only a clean commit that origin/main already has. The
 * rule lives here, in the script every caller runs, so no hook, shell or
 * workflow can publish an unpushed, rewritten or abandoned commit: before this
 * rule a local Stop hook published seven commits that exist on no branch.
 *
 * The version it makes carries the sha as its tag and its message, so
 * `wrangler deployments list` and `scripts/canary/rollback-verdict.ts` name the
 * commit without a receipt from the machine that deployed.
 */

export interface RevisionFacts {
  /** The commit the build is stamped with (git `HEAD`, jj `@-`). */
  readonly sha: string
  /** Uncommitted changes, one status line each; empty when clean. */
  readonly dirty: ReadonlyArray<string>
  /** Whether origin's main already contains `sha`. */
  readonly onOriginMain: boolean
  /** The commit's first description line. */
  readonly subject: string
}

export type RevisionVerdict =
  | { readonly ok: true; readonly sha: string; readonly tag: string; readonly message: string }
  | { readonly ok: false; readonly reason: "no-sha" | "dirty" | "not-on-origin-main"; readonly detail: string }

/** Cloudflare keeps at most this many bytes of a version's `workers/message`. */
export const MESSAGE_MAX_BYTES = 100

const encoder = new TextEncoder()

/** Cut on a character boundary so a multi-byte subject never leaves half a code point. */
const truncateBytes = (text: string, max: number): string => {
  let out = ""
  for (const char of text) {
    if (encoder.encode(out + char).length > max) break
    out += char
  }
  return out
}

export const judgeRevision = (facts: RevisionFacts, mode: "dry-run" | "real"): RevisionVerdict => {
  if (!/^[0-9a-f]{40}$/.test(facts.sha)) {
    return { ok: false, reason: "no-sha", detail: `cannot read the revision to deploy (got ${JSON.stringify(facts.sha)})` }
  }
  if (mode === "real" && facts.dirty.length > 0) {
    return { ok: false, reason: "dirty", detail: `uncommitted changes would ship under ${facts.sha}: ${facts.dirty.join(", ")}` }
  }
  if (mode === "real" && !facts.onOriginMain) {
    return { ok: false, reason: "not-on-origin-main", detail: `${facts.sha} is not on origin/main; push main first, deploys ship only commits on origin/main` }
  }
  return {
    ok: true,
    sha: facts.sha,
    tag: facts.sha.slice(0, 12),
    message: truncateBytes(`${facts.sha} ${facts.subject}`.trim(), MESSAGE_MAX_BYTES)
  }
}

export const wranglerDeployArgs = (verdict: Extract<RevisionVerdict, { ok: true }>): ReadonlyArray<string> => [
  "deploy",
  "--tag",
  verdict.tag,
  "--message",
  verdict.message
]

const capture = async (cmd: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn([...cmd], { cwd, env: { ...process.env, PWD: cwd }, stdout: "pipe", stderr: "inherit" })
  const output = await new Response(proc.stdout).text()
  return { exitCode: await proc.exited, output: output.trim() }
}

/**
 * Reads the facts from the checkout's own VCS. A native jj workspace has no
 * .git directory, and a colocated checkout's Git HEAD may lag its jj state, so
 * the caller names the VCS. A jj checkout deploys `@-`, the commit under the
 * working copy. The reads run one after another: concurrent jj commands each
 * snapshot the working copy and fork the operation log.
 */
export const readRevisionFacts = async (options: { readonly cwd: string; readonly vcs: "jj" | "git" }): Promise<RevisionFacts> => {
  const { cwd, vcs } = options
  const commands =
    vcs === "jj"
      ? {
          status: ["jj", "diff", "--summary"],
          head: ["jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id"],
          subject: ["jj", "log", "--no-graph", "-r", "@-", "-T", "description.first_line()"],
          ancestry: ["jj", "log", "--no-graph", "-r", "@- & ::main@origin", "-T", "commit_id"]
        }
      : {
          status: ["git", "status", "--porcelain"],
          head: ["git", "rev-parse", "HEAD"],
          subject: ["git", "log", "-1", "--format=%s"],
          ancestry: ["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"]
        }
  const status = await capture(commands.status, cwd)
  if (status.exitCode !== 0) throw new Error(`cannot read the working-tree state in ${cwd}`)
  const head = await capture(commands.head, cwd)
  const subject = await capture(commands.subject, cwd)
  const ancestry = await capture(commands.ancestry, cwd)
  return {
    sha: head.exitCode === 0 ? head.output : "",
    dirty: status.output.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
    // git answers by exit code; jj prints the commit only when the revset matches.
    onOriginMain: ancestry.exitCode === 0 && (vcs === "git" || ancestry.output !== ""),
    subject: subject.exitCode === 0 ? subject.output : ""
  }
}
