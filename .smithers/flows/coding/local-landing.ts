/**
 * Landing without the backend: the working copy's own jj repository and `gh`.
 *
 * `prepare` builds one candidate commit, the cleaned tip merged onto main with
 * main as its sole parent, without touching the working-copy change. The
 * fast-forward lander then runs the project's checks on it and moves main;
 * the pull-request lander pushes it as `smithers/landing-<request>` and lets
 * GitHub's required checks and branch protection decide the merge. Nothing
 * here retains a source with the backend or reads a credential: the operator's
 * `gh auth login` and jj identity reach these processes through the selected
 * environment only.
 */
import { Effect, type FileSystem, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { runSourceProcess } from "./immutable-source.ts"
import type {
  GreenPrefixInput,
  GreenPrefixOutcome,
  LandingCandidate,
  LocalLander,
  LocalPull,
  PullChecks,
  StackPublicationInput
} from "./landing-schema.vibe"
import { Landing, type LocalLanding } from "./landing.ts"
import { NativeCoding } from "./native.ts"
import { CodingError, type Receipt } from "./schema.ts"
import { cleanedTipRefusal, type VibeCleanup } from "./vibe-schema.ts"

export interface Options {
  readonly kind: LocalLander
  readonly repositoryPath: string
  readonly fs: FileSystem.FileSystem
  /** PATH, HOME and the `gh`/jj settings the operator selected; nothing else reaches these processes. */
  readonly environment: Readonly<Record<string, string>>
  /** The bookmark a candidate lands on. */
  readonly target?: string | undefined
}

const commit = /^[0-9a-f]{40}$/
const change = /^[k-z]{32}$/
const evicted = (message: string) => new CodingError({ code: "evicted", message })
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const bounded = (text: string, limit = 2_048) => {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
const jjMinutes = 2, gitMinutes = 5, ghMinutes = 2
/** Stack rows one `jj log` answers within the process output limit. */
const stackPage = 1_000
/** `gh pr view --json`; only the fields a receipt needs. */
const PullView = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String }))
})
/** `gh pr checks --required --json`. */
const CheckRows = Schema.Array(Schema.Struct({ name: Schema.String, bucket: Schema.String })).check(
  Schema.isMaxLength(256)
)

/** A stack commit's slow-check verdict: no receipt, or only an outage, is `unknown`. */
export type Verdict = "passed" | "failed" | "unknown"
/**
 * The newest commit of `stack` (oldest first) that passed with no failed
 * commit at or below it. An untested commit inherits nothing and blocks
 * nothing: a pass above it covered its tree too.
 */
export const greenPrefix = (
  stack: ReadonlyArray<string>,
  verdicts: ReadonlyMap<string, Verdict>
): string | undefined => {
  let green: string | undefined
  for (const commitId of stack) {
    const verdict = verdicts.get(commitId)
    if (verdict === "failed") break
    if (verdict === "passed") green = commitId
  }
  return green
}
/**
 * Fold receipts into verdicts for the commits in `trees`. Only slow and
 * delivery receipts of a `required` check count; superseded ones never do. A
 * real failure of any required check fails the commit; a commit passes once
 * every required check has a passed receipt; anything else, including a check
 * whose only receipt is an outage (`fault`), is no verdict yet. A receipt for
 * another tree refuses.
 */
const verdictsOf = (
  receipts: ReadonlyArray<Receipt>,
  trees: ReadonlyMap<string, string>,
  required: ReadonlyArray<string>
) => {
  const failed = new Set<string>(), passed = new Map<string, Set<string>>()
  for (const receipt of receipts) {
    const tree = trees.get(receipt.commitId)
    if (
      tree === undefined || receipt.tier === "fast" || receipt.status === "superseded" ||
      !required.includes(receipt.checkId)
    ) continue
    if (receipt.treeId !== tree) {
      return invalid(`The receipt for ${receipt.commitId} names tree ${receipt.treeId}, not its commit's tree ${tree}`)
    }
    if (receipt.status === "passed") {
      passed.set(receipt.commitId, (passed.get(receipt.commitId) ?? new Set()).add(receipt.checkId))
    } else if (receipt.fault === undefined) failed.add(receipt.commitId)
  }
  const verdicts = new Map<string, Verdict>()
  for (const commitId of trees.keys()) {
    const checks = passed.get(commitId)
    verdicts.set(
      commitId,
      failed.has(commitId)
        ? "failed"
        : checks !== undefined && required.every((check) => checks.has(check))
        ? "passed"
        : "unknown"
    )
  }
  return verdicts
}

export const make = (options: Options) =>
  Effect.gen(function*() {
    const native = yield* NativeCoding, spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = options.repositoryPath, target = options.target ?? "main"
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target)) {
      return yield* unavailable("The landing target must be a bookmark name")
    }
    const run = (argv: ReadonlyArray<string>, minutes: number) =>
      runSourceProcess(options, argv, root, minutes * 60_000).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) =>
          error instanceof CodingError
            ? error
            : unavailable(`${argv[0]} could not run on this host: ${bounded(String(error), 500)}`)
        )
      )
    /** A jj command that must succeed; its stderr is the refusal. */
    const jj = (args: ReadonlyArray<string>) =>
      run(["jj", "--no-pager", "--color=never", ...args], jjMinutes).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(unavailable(`jj ${args[0]} refused: ${bounded(result.stderr.text, 1_024)}`))
        )
      )
    const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
    /** Exactly one revision's field, or a refusal naming what was ambiguous. */
    const one = (revset: string, template: string, what: string) =>
      jj(["log", "--no-graph", "-r", revset, "-T", `${template} ++ "\\n"`]).pipe(
        Effect.flatMap((result) => {
          const found = lines(result.stdout.text)
          return found.length === 1 && !result.stdout.truncated
            ? Effect.succeed(found[0]!)
            : Effect.fail(invalid(`${what} must resolve to one revision (${found.length} found)`))
        })
      )
    const readMain = one(target, "commit_id", `The ${target} bookmark`).pipe(
      Effect.flatMap((id) => commit.test(id) ? Effect.succeed(id) : Effect.fail(invalid(`${target} is not a commit`)))
    )
    const marker = (requestId: string) => `smithers/landing ${requestId}`
    const described = (description: string) => `description(exact:${JSON.stringify(`${description}\n`)})`
    // An absent revision is nothing to abandon, and jj skips one already hidden, so a replay is a no-op.
    const abandonRevset = (revset: string) => jj(["abandon", "-r", `present(${revset})`]).pipe(Effect.asVoid)
    const prepare = (cleanup: VibeCleanup, requestId: string) =>
      Effect.gen(function*() {
        const refusal = cleanedTipRefusal(cleanup)
        if (refusal !== undefined) return yield* invalid(refusal)
        if (!/^[0-9a-f-]{36}$/.test(requestId)) return yield* invalid("A candidate needs this run's request identity")
        const tip = cleanup.head.commitId
        const atoms = cleanup.result.changes.flatMap((entry) => entry.implementation.atoms.map((atom) => atom.commitId))
        if (!commit.test(tip) || atoms.some((id) => !commit.test(id))) {
          return yield* invalid("A candidate needs full immutable native commit IDs")
        }
        // A crashed earlier attempt leaves its marked commits; they are not a candidate.
        yield* abandonRevset(
          `${described(`${marker(requestId)} merge`)} | ${described(`${marker(requestId)} candidate`)}`
        )
        const main = yield* readMain
        // The commits to land are the tip's line after main. This request's
        // validated atoms must all be on it: an atom main already has, or one
        // on another line, is not this request's delivery.
        const foreign = yield* jj([
          "log",
          "--no-graph",
          "-r",
          `(${atoms.join(" | ")}) ~ (ancestors(${tip}) ~ ancestors(${main}))`,
          "-T",
          "commit_id ++ \"\\n\""
        ])
        if (lines(foreign.stdout.text).length !== 0) {
          return yield* invalid("The validated atoms are not the cleaned tip's line after main")
        }
        yield* jj(["new", main, tip, "--no-edit", "-m", `${marker(requestId)} merge`])
        const merge = yield* one(described(`${marker(requestId)} merge`), "commit_id", "The merge commit")
        const conflicted = yield* one(merge, "if(conflict, \"conflict\", \"clean\")", "The merge commit")
        if (conflicted === "conflict") {
          const paths = yield* jj(["resolve", "-r", merge, "--list"]).pipe(
            Effect.map((result) => lines(result.stdout.text).map((line) => line.split(/\s{2,}|\t/, 1)[0]!)),
            Effect.orElseSucceed(() => [] as Array<string>)
          )
          yield* abandonRevset(merge)
          return yield* evicted(`The cleaned tip conflicts with ${target}: ${bounded(paths.join(", "), 1_024)}`)
        }
        yield* jj(["new", main, "--no-edit", "-m", `${marker(requestId)} candidate`])
        const placeholder = yield* one(described(`${marker(requestId)} candidate`), "change_id", "The candidate")
        if (!change.test(placeholder)) return yield* invalid("The candidate has no native change identity")
        yield* jj(["restore", "--from", merge, "--into", placeholder])
        yield* abandonRevset(merge)
        const empty = yield* one(placeholder, "if(empty, \"empty\", \"changed\")", "The candidate")
        if (empty === "empty") {
          yield* abandonRevset(placeholder)
          return yield* evicted(`The cleaned tip changes nothing on ${target}`)
        }
        yield* jj(["describe", "-r", placeholder, "-m", cleanup.summary])
        const mainChange = yield* one(main, "change_id", `The ${target} bookmark`)
        const read = yield* native.read([mainChange, placeholder]).pipe(
          Effect.mapError((error) => unavailable(`The candidate could not be read: ${error.message}`))
        )
        const revision = (changeId: string) => {
          const found = read.revisions.find((entry) => entry.changeId === changeId)
          return found === undefined || found.kind !== "resolved" ? undefined : {
            changeId: found.changeId,
            commitId: found.commitId,
            treeId: found.treeId,
            operationId: read.operationId,
            parentCommitIds: [...found.parentCommitIds]
          }
        }
        const base = revision(mainChange), candidate = revision(placeholder)
        if (
          base === undefined || base.commitId !== main || candidate === undefined ||
          candidate.parentCommitIds.length !== 1 || candidate.parentCommitIds[0] !== main
        ) {
          yield* abandonRevset(placeholder)
          return yield* invalid(`The candidate is not one resolved commit on ${target}`)
        }
        return { lander: options.kind, main: base, summary: cleanup.summary, candidate }
      })
    /** Move the bookmark forward only; jj refuses a backwards or sideways move. */
    const moveTarget = (to: string, from: string) =>
      Effect.gen(function*() {
        const moved = yield* run(["jj", "--no-pager", "--color=never", "bookmark", "set", target, "-r", to], jjMinutes)
        if (moved.exitCode !== 0) {
          return yield* /backwards or sideways/.test(moved.stderr.text)
            ? evicted(`${target} moved from ${from} while it was being advanced`)
            : unavailable(`jj bookmark set refused: ${bounded(moved.stderr.text, 1_024)}`)
        }
        const landed = yield* readMain
        if (landed !== to) return yield* invalid(`${target} is ${landed}, not ${to}`)
        return landed
      })
    const fastForward = (prepared: LandingCandidate) =>
      Effect.gen(function*() {
        const main = yield* readMain
        if (main === prepared.candidate.commitId) return main
        if (main !== prepared.main.commitId) {
          return yield* evicted(
            `${target} moved from ${prepared.main.commitId} to ${main} after the candidate was verified`
          )
        }
        return yield* moveTarget(prepared.candidate.commitId, main)
      })
    const advanceGreenPrefix = (input: GreenPrefixInput): Effect.Effect<GreenPrefixOutcome, CodingError> =>
      Effect.gen(function*() {
        if (options.kind !== "fast-forward") {
          return yield* unavailable(`The ${options.kind} lander does not move ${target}; GitHub does`)
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.tip)) {
          return yield* invalid("The stack tip must be a bookmark name or a commit ID")
        }
        if (input.required.length === 0) return yield* invalid("Name at least one required check")
        const main = yield* readMain
        const tip = yield* one(`present(${input.tip})`, "commit_id", "The stack tip")
        const below = yield* jj(["log", "--no-graph", "-r", `${main} & ::${tip}`, "-T", "commit_id ++ \"\\n\""])
        if (lines(below.stdout.text).length !== 1) {
          return yield* new CodingError({
            code: "stale_revision",
            message: `The stack tip ${tip} does not descend from ${target} ${main}; ${target} only fast-forwards`
          })
        }
        // A process answers at most 128 KiB, so a long stack is read newest first, a page at a time.
        const newestFirst: Array<{ commitId: string; changeId: string; parents: Array<string> }> = []
        for (let cursor = tip; cursor !== main;) {
          const listed = yield* jj([
            "log",
            "--no-graph",
            "--limit",
            String(stackPage),
            "-r",
            `${main}..${cursor}`,
            "-T",
            "commit_id ++ \" \" ++ change_id ++ \" \" ++ parents.map(|p| p.commit_id()).join(\",\") ++ \"\\n\""
          ])
          if (listed.stdout.truncated) return yield* invalid("The stack listing was truncated")
          const page = lines(listed.stdout.text).map((line) => {
            const [commitId = "", changeId = "", parents = ""] = line.split(" ")
            return { commitId, changeId, parents: parents.split(",").filter((id) => id !== "") }
          })
          newestFirst.push(...page)
          const parent = page.at(-1)?.parents
          if (parent?.length !== 1) {
            return yield* invalid(`The stack from ${target} to ${tip} is not one line of commits`)
          }
          cursor = parent[0]!
        }
        const rows = newestFirst.reverse()
        // The mythical history is one line: each commit's sole parent is the one below it.
        const linear = rows.every((row, index) =>
          commit.test(row.commitId) && change.test(row.changeId) && row.parents.length === 1 &&
          row.parents[0] === (index === 0 ? main : rows[index - 1]!.commitId)
        )
        if (!linear) return yield* invalid(`The stack from ${target} to ${tip} is not one line of commits`)
        const read = rows.length === 0 ? undefined : yield* native.read(rows.map((row) => row.changeId)).pipe(
          Effect.mapError((error) => unavailable(`The stack could not be read: ${error.message}`))
        )
        const trees = new Map<string, string>()
        for (const row of rows) {
          const found = read?.revisions.find((entry) => entry.changeId === row.changeId)
          if (found === undefined || found.kind !== "resolved" || found.commitId !== row.commitId) {
            return yield* invalid(`The stack commit ${row.commitId} is not one resolved revision`)
          }
          trees.set(row.commitId, found.treeId)
        }
        const verdicts = verdictsOf(input.receipts, trees, input.required)
        if (verdicts instanceof CodingError) return yield* verdicts
        const stack = rows.map((row) => row.commitId)
        const green = greenPrefix(stack, verdicts)
        if (green === undefined) {
          const failed = stack.find((commitId) => verdicts.get(commitId) === "failed")
          return {
            status: "unchanged" as const,
            main,
            reason: failed === undefined ? `no passed commit above ${target}` : `${failed} failed above ${target}`
          }
        }
        // The stack may be rewritten while it is read: move only to a visible commit still under the tip.
        const onStack = jj([
          "log",
          "--no-graph",
          "-r",
          `${green} & ::present(${input.tip}) & ::visible_heads()`,
          "-T",
          "commit_id ++ \"\\n\""
        ]).pipe(Effect.map((result) => lines(result.stdout.text).length === 1))
        if (!(yield* onStack)) {
          return yield* evicted(`${green} left the stack under ${input.tip} while ${target} was being advanced`)
        }
        const moved = yield* run(
          ["jj", "--no-pager", "--color=never", "bookmark", "set", target, "-r", green],
          jjMinutes
        )
        const now = yield* readMain
        if (moved.exitCode !== 0) {
          if (!/backwards or sideways/.test(moved.stderr.text)) {
            return yield* unavailable(`jj bookmark set refused: ${bounded(moved.stderr.text, 1_024)}`)
          }
          // Another advance got there first: main already holds the green commit.
          const past = yield* jj(["log", "--no-graph", "-r", `${green} & ::${now}`, "-T", "commit_id ++ \"\\n\""])
          return lines(past.stdout.text).length === 1
            ? { status: "unchanged" as const, main: now, reason: `${target} already holds ${green}` }
            : yield* evicted(`${target} moved from ${main} to ${now} while it was being advanced`)
        }
        if (now !== green) return yield* invalid(`${target} is ${now}, not ${green}`)
        if (!(yield* onStack)) {
          return yield* evicted(`${target} moved to ${green}, which left the stack under ${input.tip} during the move`)
        }
        return { status: "advanced" as const, from: main, to: green, above: stack.length - 1 - stack.indexOf(green) }
      })
    const abandon = (prepared: LandingCandidate) => abandonRevset(prepared.candidate.commitId)
    const gh = (args: ReadonlyArray<string>) => run(["gh", ...args], ghMinutes)
    const branchFor = (requestId: string) => `smithers/landing-${requestId}`
    const viewPull = (branch: string) =>
      gh(["pr", "view", branch, "--json", "number,url,state,headRefOid,headRefName,baseRefName,mergeCommit"]).pipe(
        Effect.flatMap((result) => {
          if (result.exitCode !== 0) {
            return /no pull requests found/i.test(result.stderr.text)
              ? Effect.succeed(undefined)
              : Effect.fail(unavailable(`gh pr view refused: ${bounded(result.stderr.text, 1_024)}`))
          }
          return Effect.try({
            try: () => JSON.parse(result.stdout.text) as unknown,
            catch: () => invalid("gh pr view returned no JSON")
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PullView)),
            Effect.mapError((error) =>
              error instanceof CodingError ? error : invalid("gh pr view returned an unexpected pull request shape")
            ),
            Effect.map((view): LocalPull => ({
              number: view.number,
              url: view.url,
              state: view.state === "OPEN" ? "open" : view.state === "MERGED" ? "merged" : "closed",
              headRef: view.headRefName,
              headSha: view.headRefOid,
              baseRef: view.baseRefName,
              mergeCommitId: view.mergeCommit?.oid ?? null
            }))
          )
        })
      )
    const openPull = (prepared: LandingCandidate, requestId: string) =>
      Effect.gen(function*() {
        if (!/^[0-9a-f-]{36}$/.test(requestId)) {
          return yield* invalid("A pull request needs this run's request identity")
        }
        if (!(yield* options.fs.exists(`${root}/.git`).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* unavailable("The pull-request lander needs a colocated Git repository (jj git init --colocate)")
        }
        const branch = branchFor(requestId), tip = prepared.candidate.commitId
        // Unforced: a branch already at the tip is up to date; one that moved is refused, never overwritten.
        const pushed = yield* run(["git", "push", "origin", `${tip}:refs/heads/${branch}`], gitMinutes)
        if (pushed.exitCode !== 0) {
          return yield* /rejected|non-fast-forward|fetch first/i.test(pushed.stderr.text)
            ? invalid(`The branch ${branch} moved away from the candidate; it is not pushed over`)
            : unavailable(`git push refused: ${bounded(pushed.stderr.text, 1_024)}`)
        }
        const existing = yield* viewPull(branch)
        const pull = existing ?? (yield* Effect.gen(function*() {
          const summary = prepared.summary
          const created = yield* gh([
            "pr",
            "create",
            "--head",
            branch,
            "--base",
            target,
            "--title",
            summary.split(/\r?\n/, 1)[0]!,
            "--body",
            summary
          ])
          if (created.exitCode !== 0 && !/already exists/i.test(created.stderr.text)) {
            return yield* unavailable(`gh pr create refused: ${bounded(created.stderr.text, 1_024)}`)
          }
          const opened = yield* viewPull(branch)
          return opened ?? (yield* invalid(`The pull request for ${branch} was not found after it was created`))
        }))
        if (pull.headRef !== branch || pull.headSha !== tip) {
          return yield* invalid(`Pull request #${pull.number} does not carry the candidate ${tip} on ${branch}`)
        }
        return pull
      })
    const observeChecks = (pull: LocalPull) =>
      gh(["pr", "checks", String(pull.number), "--required", "--json", "name,bucket"]).pipe(
        Effect.flatMap((result): Effect.Effect<PullChecks, CodingError> => {
          let rows: unknown
          try {
            rows = JSON.parse(result.stdout.text)
          } catch {
            rows = undefined
          }
          if (!Schema.is(CheckRows)(rows)) {
            return /no (required )?checks reported/i.test(result.stderr.text)
              ? Effect.succeed({ status: "passed" as const, checks: [] })
              : Effect.fail(unavailable(`gh pr checks refused: ${bounded(result.stderr.text, 1_024)}`))
          }
          const checks = rows.map(({ name, bucket }) => ({ name, bucket }))
          const status = checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")
            ? "failed" as const
            : checks.some((check) => check.bucket === "pending")
            ? "pending" as const
            : "passed" as const
          return Effect.succeed({ status, checks })
        })
      )
    const merge = (pull: LocalPull, prepared: LandingCandidate) =>
      Effect.gen(function*() {
        // A lost reply may have left the merge applied. Observe the exact
        // pull and candidate before either acknowledging it or sending again.
        const before = yield* viewPull(pull.headRef)
        if (
          before === undefined || before.number !== pull.number || before.headRef !== pull.headRef ||
          before.headSha !== prepared.candidate.commitId || before.baseRef !== target || before.state === "closed"
        ) {
          return yield* invalid("The pull request no longer carries this candidate on the landing target")
        }
        if (before.state === "merged") {
          return before.mergeCommitId !== null && commit.test(before.mergeCommitId)
            ? { status: "merged" as const, mainCommitId: before.mergeCommitId }
            : yield* unavailable(`Pull request #${pull.number} is merged but its merge commit was not observed`)
        }
        const summary = prepared.summary
        const merged = yield* gh([
          "pr",
          "merge",
          String(pull.number),
          "--squash",
          "--match-head-commit",
          prepared.candidate.commitId,
          "--subject",
          summary.split(/\r?\n/, 1)[0]!,
          "--body",
          summary
        ])
        const after = yield* viewPull(pull.headRef)
        if (after?.state === "merged" && after.mergeCommitId !== null && commit.test(after.mergeCommitId)) {
          return { status: "merged" as const, mainCommitId: after.mergeCommitId }
        }
        if (merged.exitCode === 0) {
          return yield* unavailable(`gh merged pull request #${pull.number} but its merge commit was not observed`)
        }
        return { status: "open" as const, reason: bounded(merged.stderr.text) }
      })
    /** The remote branch's head as last fetched, or `null` when the remote has no such branch. */
    const remoteHead = (remote: string, branch: string) =>
      jj([
        "log",
        "--no-graph",
        "-r",
        `remote_bookmarks(exact:${JSON.stringify(branch)}, exact:${JSON.stringify(remote)})`,
        "-T",
        "commit_id ++ \"\\n\""
      ]).pipe(Effect.flatMap((result) => {
        const found = lines(result.stdout.text)
        return found.length <= 1
          ? Effect.succeed(found[0] ?? null)
          : Effect.fail(invalid(`${branch}@${remote} is conflicted on the remote (${found.length} heads)`))
      }))
    const fetchBranch = (remote: string, branch: string) =>
      jj(["git", "fetch", "--remote", remote, "--branch", `exact:${branch}`])
    /** Every Change is exactly its named commit among `head`'s ancestors: an old or missing version refuses. */
    const carries = (head: string, changes: StackPublicationInput["changes"], where: string) =>
      Effect.forEach(changes, ({ changeId, commitId }) =>
        jj(["log", "--no-graph", "-r", `change_id(${changeId}) & ::${head}`, "-T", "commit_id ++ \"\\n\""]).pipe(
          Effect.flatMap((result) => {
            const found = lines(result.stdout.text)
            if (found.length === 1 && found[0] === commitId) {
              return Effect.void
            }
            return Effect.fail(invalid(
              found.length === 0
                ? `${changeId} is not ${where}`
                : `${changeId} is ${found.join(", ")} ${where}, not ${commitId}`
            ))
          })
        ), { discard: true })
    const publishStack = (input: StackPublicationInput) =>
      Effect.gen(function*() {
        const remote = input.remote ?? "origin", branch = input.branch
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || /\.\.|\/\/|\/$|\.lock$|^refs\//.test(branch)
        ) {
          return yield* invalid("The publication branch must be a bookmark name")
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(remote)) {
          return yield* invalid("The publication remote must be a remote name")
        }
        const commits = [
          input.tip,
          ...input.changes.map((entry) =>
            entry.commitId
          )
        ]
        if (
          commits.some((id) =>
            !commit.test(id)
          ) || input.changes.some((entry) => !change.test(entry.changeId)) ||
          (input.expected !== null && !commit.test(input.expected))
        ) {
          return yield* invalid("A publication needs full commit and change IDs")
        }
        // A full commit id still resolves an abandoned commit: an obsolete tip is not the stack.
        if ((yield* one(input.tip, "if(hidden, \"hidden\", \"visible\")", "The stack tip")) === "hidden") {
          return yield* invalid(`The stack tip ${input.tip} was rewritten or abandoned`)
        }
        yield* carries(input.tip, input.changes, "on the stack")
        const where = `${branch}@${remote}`
        yield* fetchBranch(remote, branch)
        const observed = yield* remoteHead(remote, branch)
        if (observed !== input.tip) {
          if (observed !== input.expected) {
            return yield* evicted(
              `${where} moved from ${input.expected ?? "no branch"} to ${
                observed ?? "no branch"
              }; it is not pushed over`
            )
          }
          const conflicted = yield* jj([
            "log",
            "--no-graph",
            "-r",
            `(::${input.tip} ~ ::remote_bookmarks(remote=exact:${JSON.stringify(remote)})) & conflicts()`,
            "-T",
            "commit_id ++ \"\\n\""
          ])
          if (lines(conflicted.stdout.text).length !== 0) {
            return yield* invalid(`The stack has conflicted commits: ${bounded(conflicted.stdout.text, 1_024)}`)
          }
          // The lease is git's, on the exact expected head (empty: no branch), checked by the remote
          // itself. jj's own push lease is its remote-tracking ref, which any fetch in this
          // repository can move.
          const gitDir = (yield* jj(["git", "root"])).stdout.text.trim()
          const pushed = yield* run([
            "git",
            "--git-dir",
            gitDir,
            "push",
            "--porcelain",
            `--force-with-lease=refs/heads/${branch}:${input.expected ?? ""}`,
            remote,
            `${input.tip}:refs/heads/${branch}`
          ], gitMinutes)
          if (pushed.exitCode !== 0) {
            return yield* /stale info|\[rejected\]|non-fast-forward|fetch first/i.test(
                `${pushed.stdout.text}\n${pushed.stderr.text}`
              )
              ? evicted(`${where} moved during publication; it is not pushed over`)
              : unavailable(`git push refused: ${bounded(pushed.stderr.text, 1_024)}`)
          }
        }
        // Confirmation reads the remote again, not anything local.
        yield* fetchBranch(remote, branch)
        const published = yield* remoteHead(remote, branch)
        if (published !== input.tip) {
          const message = `${where} is ${published ?? "absent"} after publication, not ${input.tip}`
          // Another writer moved or deleted it after the push.
          return yield* evicted(message)
        }
        yield* carries(published, input.changes, `on ${where}`)
        // Track it, as a jj push would: jj treats an untracked remote bookmark as immutable, and a
        // later correction must still amend the published stack in place.
        yield* jj(["bookmark", "track", branch, "--remote", remote])
        yield* jj(["bookmark", "set", branch, "-r", published, "--allow-backwards"])
        return { remote, branch, previous: input.expected, head: published, changes: input.changes }
      })
    const service: LocalLanding = {
      kind: options.kind,
      prepare,
      fastForward,
      advanceGreenPrefix,
      abandon,
      openPull,
      observeChecks,
      merge,
      publishStack
    }
    return service
  })
export const layer = (options: Options) => Layer.effect(Landing)(make(options))
