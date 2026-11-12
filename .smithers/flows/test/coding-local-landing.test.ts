/**
 * The local landers over a real colocated jj repository: `prepare` builds the
 * one candidate commit without touching the working copy, the fast-forward
 * lander moves main or evicts, and the pull-request lander pushes to a real
 * bare remote and drives `gh` (a recording stand-in on PATH: GitHub itself is
 * the only thing not here).
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LocalLanding } from "../coding/landing.ts"
import { greenPrefix, make } from "../coding/local-landing.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError, type Receipt, type Revision } from "../coding/schema.ts"
import type { VibeCleanup } from "../coding/vibe-schema.ts"

const environment: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? tmpdir(),
  JJ_USER: "Smithers Test",
  JJ_EMAIL: "smithers@example.test",
  // No user configuration reaches the repository under test.
  JJ_CONFIG: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
}
const sh = (cwd: string, file: string, args: ReadonlyArray<string>, env = environment) =>
  execFileSync(file, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const jj = (cwd: string, ...args: string[]) => sh(cwd, "jj", ["--no-pager", "--color=never", ...args])
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", args)
/** The colocated `.git`, or the store a plain jj repository keeps under `.jj`. */
const gitDirOf = (cwd: string) => existsSync(join(cwd, ".git")) ? join(cwd, ".git") : join(cwd, ".jj/repo/store/git")
const commitOf = (cwd: string, revset: string) => jj(cwd, "log", "--no-graph", "-r", revset, "-T", "commit_id")
const changeOf = (cwd: string, revset: string) => jj(cwd, "log", "--no-graph", "-r", revset, "-T", "change_id")
const filesOf = (cwd: string, revset: string) => jj(cwd, "file", "list", "-r", revset).split("\n").sort()
const markers = (cwd: string) =>
  jj(cwd, "log", "--no-graph", "-r", "description(glob:\"smithers/landing*\")", "-T", "commit_id ++ \"\\n\"")
const revisionOf = (cwd: string, revset: string): Revision => {
  const commitId = commitOf(cwd, revset)
  return {
    changeId: changeOf(cwd, revset),
    commitId,
    treeId: git(cwd, "--git-dir", gitDirOf(cwd), "rev-parse", `${commitId}^{tree}`),
    operationId: jj(cwd, "op", "log", "-n", "1", "--no-graph", "-T", "id"),
    parentCommitIds: jj(cwd, "log", "--no-graph", "-r", revset, "-T", "parents.map(|p| p.commit_id()).join(\" \")")
      .split(" ").filter((id) => id !== "")
  }
}
/** The native helper is a packaged binary; its `read` is answered here from jj and the colocated git store. */
const nativeOf = (root: string, afterRead: () => void = () => {}) =>
  Layer.succeed(NativeCoding, {
    sourcePublication: "local-only",
    read: (changeIds = []) =>
      Effect.sync(() => {
        const read = {
          status: "read" as const,
          operationId: jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id"),
          head: { ...revisionOf(root, "@"), kind: "resolved" as const },
          revisions: changeIds.map((changeId) => ({
            ...revisionOf(root, `change_id("${changeId}")`),
            kind: "resolved" as const
          }))
        }
        afterRead()
        return read
      }),
    apply: () => Effect.die("a lander never applies native operations"),
    publishOriginalSource: () => Effect.die("a local lander never retains a source with the backend")
  })
/** A validated request of these atoms on top of `base`, as cleanup leaves it: the tip is the last atom. */
const cleanupOf = (base: Revision, atoms: ReadonlyArray<Revision>): VibeCleanup => {
  const head = atoms.at(-1)!
  const changes = atoms.map((atom, index) => ({
    implementation: {
      change: `change-${index}`,
      parent: index === 0 ? base : atoms[index - 1]!,
      atoms: [atom],
      head: atom,
      reads: [],
      writes: [`file-${index}.txt`]
    },
    receipts: []
  }))
  const result = { status: "validated" as const, findings: [], changes }
  const plan = {
    prompt: "land",
    memoryRevision: "wiki",
    base,
    observedHead: base,
    changes: atoms.map((_, index) => ({
      id: `change-${index}`,
      title: `change ${index}`,
      intent: "land",
      implementation: "coding/implementation",
      implementationDigest: "0".repeat(64),
      atoms: [{ changeId: null, message: `✨ feat: change ${index}`, intent: "land", reads: [], writes: [] }],
      checks: []
    }))
  }
  return {
    summary: "✨ feat: land the validated request\n\nTwo atoms, one commit.",
    result,
    head,
    admission: {
      requestExecutionId: "request",
      controlRunId: "control",
      planId: "plan",
      planDigest: "digest",
      originalSource: base,
      validatedHead: head,
      request: { plan, outcome: { status: "validated", rounds: 1, blocked: null, result } }
    }
  }
}
const requestId = "0f0f0f0f-0f0f-8f0f-af0f-0f0f0f0f0f0f"
type Cleanup = { after: (fn: () => Promise<void>) => void }
/** base (main) ← atom0 ← atom1, with @ an empty change on top. */
const repository = async (t: Cleanup, colocate = true) => {
  const root = await mkdtemp(join(tmpdir(), "coding-local-landing-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  jj(root, "git", "init", ...(colocate ? [] : ["--no-colocate"]))
  await writeFile(join(root, "a.txt"), "a\n")
  jj(root, "commit", "-m", "base")
  jj(root, "bookmark", "create", "main", "-r", "@-")
  const base = revisionOf(root, "main")
  await writeFile(join(root, "file-0.txt"), "first\n")
  jj(root, "commit", "-m", "✨ feat: first")
  await writeFile(join(root, "file-1.txt"), "second\n")
  jj(root, "commit", "-m", "✨ feat: second")
  const atoms = [revisionOf(root, "@--"), revisionOf(root, "@-")]
  return { root, base, atoms, cleanup: cleanupOf(base, atoms), workingCopy: commitOf(root, "@") }
}
/** Main moves on with `file` = `text`, edited in a second workspace so @ stays where it is. */
const moveMain = async (root: string, file: string, text: string) => {
  jj(root, "new", "main", "--no-edit", "-m", `other work on ${file}`)
  const change = changeOf(root, `description(exact:"other work on ${file}\\n")`)
  const scratch = await mkdtemp(join(tmpdir(), "coding-local-landing-edit-"))
  jj(root, "workspace", "add", "--name", "other", "-r", change, scratch)
  jj(scratch, "edit", change)
  await writeFile(join(scratch, file), text)
  jj(scratch, "bookmark", "set", "main", "-r", "@")
  jj(scratch, "workspace", "forget", "other")
  await rm(scratch, { recursive: true, force: true })
  return commitOf(root, "main")
}
const landerOf = (root: string, kind: LocalLanding["kind"], env = environment, afterRead?: () => void) =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => make({ kind, repositoryPath: root, fs, environment: env })).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, nativeOf(root, afterRead)))
    )
  )
const failure = <A>(effect: Effect.Effect<A, CodingError>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => {
    assert.ok(error instanceof CodingError)
    return error
  })

test("fast-forward lander: the tip merged onto a moved main lands as one commit", async (t) => {
  const { root, cleanup, atoms, workingCopy } = await repository(t)
  const moved = await moveMain(root, "z.txt", "z\n")
  const lander = await landerOf(root, "fast-forward")
  const prepared = await Effect.runPromise(lander.prepare(cleanup, requestId))
  assert.equal(prepared.lander, "fast-forward")
  assert.equal(prepared.main.commitId, moved)
  assert.equal(prepared.summary, cleanup.summary)
  const candidate = prepared.candidate
  assert.deepEqual(candidate.parentCommitIds, [moved], "one commit whose sole parent is main")
  assert.equal(git(root, "rev-parse", `${candidate.commitId}^{tree}`), candidate.treeId)
  assert.deepEqual(filesOf(root, candidate.commitId), ["a.txt", "file-0.txt", "file-1.txt", "z.txt"])
  assert.equal(jj(root, "log", "--no-graph", "-r", candidate.commitId, "-T", "description"), cleanup.summary)
  assert.equal(commitOf(root, "@"), workingCopy, "the working copy never moves")
  assert.equal(commitOf(root, atoms[1]!.commitId), atoms[1]!.commitId, "the atoms stay as they are")
  assert.equal(markers(root), "", "no merge or placeholder commit is left behind")
  assert.equal(await Effect.runPromise(lander.fastForward(prepared)), candidate.commitId)
  assert.equal(commitOf(root, "main"), candidate.commitId)
  assert.equal(git(root, "rev-parse", "refs/heads/main"), candidate.commitId, "the colocated git main follows")
  assert.equal(
    await Effect.runPromise(lander.fastForward(prepared)),
    candidate.commitId,
    "a lost completion reply reconciles the already-moved bookmark"
  )
  // Landed work has nothing left to land: the same tip merged onto the new main is empty.
  const again = await failure(lander.prepare(cleanup, requestId))
  assert.equal(again.code, "evicted")
  assert.match(again.message, /changes nothing on main/)
  assert.equal(
    markers(root),
    "",
    jj(root, "log", "-r", "all()", "-T", "commit_id.short() ++ \" \" ++ description.first_line() ++ \"\\n\"")
  )
  assert.equal(commitOf(root, "main"), candidate.commitId)
})

test("fast-forward lander: main that moves after the candidate is verified evicts it", async (t) => {
  const { root, cleanup, workingCopy } = await repository(t)
  const lander = await landerOf(root, "fast-forward")
  const prepared = await Effect.runPromise(lander.prepare(cleanup, requestId))
  assert.deepEqual(filesOf(root, prepared.candidate.commitId), ["a.txt", "file-0.txt", "file-1.txt"])
  const moved = await moveMain(root, "z.txt", "z\n")
  const error = await failure(lander.fastForward(prepared))
  assert.equal(error.code, "evicted")
  assert.match(error.message, new RegExp(`main moved from ${prepared.main.commitId} to ${moved}`))
  assert.equal(commitOf(root, "main"), moved, "main is never moved sideways")
  await Effect.runPromise(lander.abandon(prepared))
  const visible = jj(root, "log", "--no-graph", "-r", "all()", "-T", "commit_id ++ \"\\n\"").split("\n")
  assert.ok(!visible.includes(prepared.candidate.commitId), "the evicted candidate is gone")
  await Effect.runPromise(lander.abandon(prepared))
  assert.equal(commitOf(root, "@"), workingCopy)
})

test("fast-forward lander: a conflicting main evicts the tip before any candidate exists", async (t) => {
  const { root, cleanup, workingCopy } = await repository(t)
  const moved = await moveMain(root, "file-0.txt", "someone else's first\n")
  const lander = await landerOf(root, "fast-forward")
  const error = await failure(lander.prepare(cleanup, requestId))
  assert.equal(error.code, "evicted")
  assert.match(error.message, /conflicts with main: file-0\.txt/)
  assert.equal(markers(root), "", "the conflicted merge is abandoned")
  assert.equal(commitOf(root, "main"), moved)
  assert.equal(commitOf(root, "@"), workingCopy)
})

test("fast-forward lander: refusals before any commit is written", async (t) => {
  const { root, cleanup, base, atoms } = await repository(t)
  const lander = await landerOf(root, "fast-forward")
  const before = jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id")
  const unvalidated = { ...cleanup, result: { ...cleanup.result, status: "changes-requested" as const } }
  assert.equal((await failure(lander.prepare(unvalidated, requestId))).code, "invalid_receipt")
  assert.equal((await failure(lander.prepare(cleanup, "not-a-request"))).code, "invalid_receipt")
  // An atom main already has is not this request's delivery.
  const onMain = await failure(lander.prepare(cleanupOf(base, [base, ...atoms]), requestId))
  assert.equal(onMain.code, "invalid_receipt")
  assert.match(onMain.message, /not the cleaned tip's line after main/)
  assert.equal(jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id"), before, "nothing was written")
})

/** `gh` as the lander drives it, recording its arguments and answering from a state directory. */
const fakeGh = async (root: string, remote: string) => {
  const bin = join(root, "..", `gh-bin-${Date.now()}`), state = join(bin, "state")
  await mkdir(state, { recursive: true })
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\t' "$@" >> "$FAKE_GH_STATE/log"; printf '\\n' >> "$FAKE_GH_STATE/log"
case "$1 $2" in
  "pr view")
    if [ -f "$FAKE_GH_STATE/pull.json" ]; then cat "$FAKE_GH_STATE/pull.json"; exit 0; fi
    echo "no pull requests found for branch \\"$3\\"" >&2; exit 1 ;;
  "pr create")
    head=""; while [ $# -gt 0 ]; do if [ "$1" = "--head" ]; then head="$2"; fi; shift; done
    sha=$(git --git-dir="$FAKE_GH_REMOTE" rev-parse "refs/heads/$head")
    printf '{"number":41,"url":"https://github.com/acme/app/pull/41","state":"OPEN","headRefOid":"%s","headRefName":"%s","baseRefName":"main","mergeCommit":null}' "$sha" "$head" > "$FAKE_GH_STATE/pull.json"
    echo "https://github.com/acme/app/pull/41"; exit 0 ;;
  "pr checks")
    if [ -f "$FAKE_GH_STATE/checks.json" ]; then cat "$FAKE_GH_STATE/checks.json"; exit 0; fi
    echo "no checks reported on the 'smithers/landing' branch" >&2; exit 1 ;;
  "pr merge")
    if [ -f "$FAKE_GH_STATE/refuse" ]; then cat "$FAKE_GH_STATE/refuse" >&2; exit 1; fi
    sed -e 's/"state":"OPEN"/"state":"MERGED"/' -e 's/"mergeCommit":null/"mergeCommit":{"oid":"9999999999999999999999999999999999999999"}/' "$FAKE_GH_STATE/pull.json" > "$FAKE_GH_STATE/merged.json"
    mv "$FAKE_GH_STATE/merged.json" "$FAKE_GH_STATE/pull.json"; exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 2
`
  )
  await chmod(join(bin, "gh"), 0o755)
  const env = { ...environment, PATH: `${bin}:${environment.PATH}`, FAKE_GH_STATE: state, FAKE_GH_REMOTE: remote }
  /** Every `gh` invocation, its arguments tab-joined; a body keeps its line breaks. */
  const log = async () =>
    (await readFile(join(state, "log"), "utf8").catch(() => "")).split("\t\n").filter((line) => line !== "")
      .map((line) => line.split("\t"))
  return { env, state, log, bin }
}

test("pull-request lander: pushes the candidate to origin, opens its pull request once, and merges on green", async (t) => {
  const { root, cleanup, atoms, workingCopy } = await repository(t)
  const remote = join(root, "..", `coding-local-landing-remote-${Date.now()}.git`)
  t.after(() => rm(remote, { recursive: true, force: true }))
  git(root, "init", "--bare", remote)
  git(root, "remote", "add", "origin", remote)
  const gh = await fakeGh(root, remote)
  t.after(() => rm(gh.bin, { recursive: true, force: true }))
  const lander = await landerOf(root, "pull-request", gh.env)
  const prepared = await Effect.runPromise(lander.prepare(cleanup, requestId))
  assert.equal(prepared.lander, "pull-request")
  const branch = `smithers/landing-${requestId}`
  const pull = await Effect.runPromise(lander.openPull(prepared, requestId))
  assert.equal(git(root, "--git-dir", remote, "rev-parse", `refs/heads/${branch}`), prepared.candidate.commitId)
  assert.deepEqual(pull, {
    number: 41,
    url: "https://github.com/acme/app/pull/41",
    state: "open",
    headRef: branch,
    headSha: prepared.candidate.commitId,
    baseRef: "main",
    mergeCommitId: null
  })
  const view = ["pr", "view", branch, "--json", "number,url,state,headRefOid,headRefName,baseRefName,mergeCommit"]
  assert.deepEqual(await gh.log(), [
    view,
    [
      "pr",
      "create",
      "--head",
      branch,
      "--base",
      "main",
      "--title",
      "✨ feat: land the validated request",
      "--body",
      cleanup.summary
    ],
    view
  ])
  // The branch is the idempotency key: a retry finds the pull request and opens nothing.
  assert.deepEqual(await Effect.runPromise(lander.openPull(prepared, requestId)), pull)
  assert.equal((await gh.log()).length, 4)
  assert.deepEqual(await Effect.runPromise(lander.observeChecks(pull)), { status: "passed", checks: [] })
  await writeFile(join(gh.state, "checks.json"), JSON.stringify([{ name: "ci", bucket: "pending" }]))
  assert.deepEqual(await Effect.runPromise(lander.observeChecks(pull)), {
    status: "pending",
    checks: [{ name: "ci", bucket: "pending" }]
  })
  await writeFile(
    join(gh.state, "checks.json"),
    JSON.stringify([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "fail" }])
  )
  assert.equal((await Effect.runPromise(lander.observeChecks(pull))).status, "failed")
  await writeFile(join(gh.state, "checks.json"), JSON.stringify([{ name: "ci", bucket: "pass" }]))
  assert.equal((await Effect.runPromise(lander.observeChecks(pull))).status, "passed")
  assert.ok(
    (await gh.log()).slice(-4).every((line) => line.join(" ") === "pr checks 41 --required --json name,bucket")
  )
  // Branch protection decides: a refused merge leaves the pull request open with GitHub's reason.
  await writeFile(join(gh.state, "refuse"), "Pull request is not mergeable: review required\n")
  assert.deepEqual(await Effect.runPromise(lander.merge(pull, prepared)), {
    status: "open",
    reason: "Pull request is not mergeable: review required"
  })
  await rm(join(gh.state, "refuse"))
  assert.deepEqual(await Effect.runPromise(lander.merge(pull, prepared)), {
    status: "merged",
    mainCommitId: "9".repeat(40)
  })
  assert.deepEqual((await gh.log()).at(-2), [
    "pr",
    "merge",
    "41",
    "--squash",
    "--match-head-commit",
    prepared.candidate.commitId,
    "--subject",
    "✨ feat: land the validated request",
    "--body",
    cleanup.summary
  ])
  const appliedPull = await readFile(join(gh.state, "pull.json"), "utf8")
  for (
    const changed of [
      { number: 42 },
      { headRefOid: "8".repeat(40) },
      { baseRefName: "other" },
      { state: "CLOSED", mergeCommit: null }
    ]
  ) {
    await writeFile(join(gh.state, "pull.json"), JSON.stringify({ ...JSON.parse(appliedPull), ...changed }))
    const before = (await gh.log()).filter((args) => args[1] === "merge").length
    assert.equal((await failure(lander.merge(pull, prepared))).code, "invalid_receipt")
    assert.equal(
      (await gh.log()).filter((args) => args[1] === "merge").length,
      before,
      "a different or closed pull request must not be merged"
    )
  }
  await writeFile(join(gh.state, "pull.json"), appliedPull)
  const mergesBeforeReplay = (await gh.log()).filter((args) => args[1] === "merge").length
  assert.deepEqual(await Effect.runPromise(lander.merge(pull, prepared)), {
    status: "merged",
    mainCommitId: "9".repeat(40)
  })
  assert.equal(
    (await gh.log()).filter((args) => args[1] === "merge").length,
    mergesBeforeReplay,
    "a lost completion reply is looked up without another merge"
  )
  assert.equal(commitOf(root, "@"), workingCopy, "the working copy never moves")
  assert.equal(commitOf(root, "main"), prepared.main.commitId, "a pull request never moves the local main")
  // A branch that moved off the candidate's line is refused, never pushed over.
  git(root, "push", "--force", "origin", `${atoms[1]!.commitId}:refs/heads/${branch}`)
  const moved = await failure(lander.openPull(prepared, requestId))
  assert.equal(moved.code, "invalid_receipt")
  assert.match(moved.message, /moved away from the candidate/)
  assert.equal(git(root, "--git-dir", remote, "rev-parse", `refs/heads/${branch}`), atoms[1]!.commitId)
})

test("pull-request lander: needs a colocated git repository", async (t) => {
  const { root, cleanup } = await repository(t, false)
  const lander = await landerOf(root, "pull-request")
  const prepared = await Effect.runPromise(lander.prepare(cleanup, requestId))
  const error = await failure(lander.openPull(prepared, requestId))
  assert.equal(error.code, "unavailable")
  assert.match(error.message, /colocated Git repository/)
})

/** main ← c1 ← c2 ← c3 ← c4, with `vibe` on c4: a mythical stack above main, @ elsewhere. */
const stackRepository = async (t: Cleanup) => {
  const root = await mkdtemp(join(tmpdir(), "coding-green-prefix-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  jj(root, "git", "init")
  await writeFile(join(root, "a.txt"), "a\n")
  jj(root, "commit", "-m", "base")
  jj(root, "bookmark", "create", "main", "-r", "@-")
  const main = commitOf(root, "main")
  const stack: Array<Revision> = []
  for (const index of [1, 2, 3, 4]) {
    await writeFile(join(root, `c${index}.txt`), `${index}\n`)
    jj(root, "commit", "-m", `✨ feat: c${index}`)
    stack.push(revisionOf(root, "@-"))
  }
  jj(root, "bookmark", "create", "vibe", "-r", "@-")
  return { root, main, stack }
}
const required = ["test"]
/** A slow check's receipt, bound to the commit's exact tree unless `treeId` says otherwise. */
const verdictOf = (
  revision: Revision,
  status: "passed" | "failed" | "superseded",
  extra: { tier?: "fast" | "slow" | "delivery"; fault?: "infra" | "factory"; treeId?: string; checkId?: string } = {}
): Receipt => ({
  checkId: extra.checkId ?? "test",
  target: "//:test",
  tier: extra.tier ?? "slow",
  change: "stack",
  commitId: revision.commitId,
  treeId: extra.treeId ?? revision.treeId,
  inputDigest: "0".repeat(64),
  status,
  ...(extra.fault === undefined ? {} : { fault: extra.fault }),
  evidence: "",
  findings: []
})

test("green prefix: pure choice over a stack, oldest first", () => {
  const verdicts = (entries: Record<string, "passed" | "failed" | "unknown">) => new Map(Object.entries(entries))
  const stack = ["c1", "c2", "c3", "c4"]
  // Untested commits inherit nothing and never block.
  assert.equal(greenPrefix(stack, verdicts({ c1: "passed", c3: "passed" })), "c3")
  // A failed commit blocks every newer pass.
  assert.equal(greenPrefix(stack, verdicts({ c1: "passed", c2: "failed", c4: "passed" })), "c1")
  // A failed tip keeps the green below it.
  assert.equal(greenPrefix(stack, verdicts({ c3: "passed", c4: "failed" })), "c3")
  // An outage is no verdict either way.
  assert.equal(greenPrefix(stack, verdicts({ c1: "passed", c2: "unknown", c3: "passed" })), "c3")
  assert.equal(greenPrefix(stack, verdicts({ c1: "failed", c3: "passed" })), undefined)
  assert.equal(greenPrefix(stack, verdicts({})), undefined)
  assert.equal(greenPrefix([], verdicts({ c1: "passed" })), undefined)
})

test("green prefix: main fast-forwards to the newest passed commit with nothing failed below it", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const workingCopy = commitOf(root, "@")
  const lander = await landerOf(root, "fast-forward")
  const [c1, , c3, c4] = stack as [Revision, Revision, Revision, Revision]
  const receipts = [verdictOf(c1, "passed"), verdictOf(c3, "passed"), verdictOf(c4, "passed", { tier: "fast" })]
  const outcome = await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts }))
  assert.deepEqual(outcome, { status: "advanced", from: main, to: c3.commitId, above: 1 })
  assert.equal(commitOf(root, "main"), c3.commitId)
  assert.equal(git(root, "rev-parse", "refs/heads/main"), c3.commitId, "the colocated git main follows")
  assert.equal(commitOf(root, "@"), workingCopy, "the working copy never moves")
  assert.equal(commitOf(root, "vibe"), c4.commitId, "the stack tip is never touched")
  // A replay, or receipts for commits main already holds, change nothing.
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts })), {
    status: "unchanged",
    main: c3.commitId,
    reason: "no passed commit above main"
  })
  // Only a fast check passed on c4: it is not green yet.
  assert.equal(commitOf(root, "main"), c3.commitId)
})

/**
 * main with `length` commits above it on bookmark `vibe`, written in one `git fast-import`, and a native read
 * answered from one listing: `merge` makes that commit, counted from the tip, a merge.
 */
const longStack = async (t: Cleanup, length: number, merge?: number) => {
  const root = await mkdtemp(join(tmpdir(), "coding-green-prefix-long-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  jj(root, "git", "init")
  await writeFile(join(root, "a.txt"), "a\n")
  jj(root, "commit", "-m", "base")
  jj(root, "bookmark", "create", "main", "-r", "@-")
  const main = commitOf(root, "main")
  const commit = (mark: number, from: string, extra = "") =>
    `commit refs/heads/vibe\nmark :${mark}\ncommitter T <t@example.test> ${1_000 + mark} +0000\ndata 2\nc\n` +
    `from ${from}\n${extra}M 100644 inline c.txt\ndata ${String(mark).length}\n${mark}\n`
  const side = `commit refs/heads/side\nmark :${length + 1}\ncommitter T <t@example.test> 999 +0000\ndata 2\ns\n` +
    `from ${main}\nM 100644 inline s.txt\ndata 1\ns\n`
  const body = Array.from(
    { length },
    (_, index) =>
      commit(
        index + 1,
        index === 0 ? main : `:${index}`,
        merge !== undefined && index + 1 === length - merge ? `merge :${length + 1}\n` : ""
      )
  ).join("")
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: root,
    env: environment,
    input: (merge === undefined ? "" : side) + body
  })
  jj(root, "git", "import")
  const listed = jj(
    root,
    "log",
    "--no-graph",
    "--reversed",
    "-r",
    "main..vibe",
    "-T",
    "change_id ++ \" \" ++ commit_id ++ \"\\n\""
  )
    .split("\n").map((line) => line.split(" ") as [string, string])
  const trees = new Map(
    git(root, "log", "--format=%H %T", "vibe").split("\n").map((line) => line.split(" ") as [string, string])
  )
  const revisions = listed.map(([changeId, commitId]) => ({
    kind: "resolved" as const,
    changeId,
    commitId,
    treeId: trees.get(commitId)!,
    operationId: "0".repeat(128),
    parentCommitIds: []
  }))
  const native = Layer.succeed(NativeCoding, {
    sourcePublication: "local-only",
    read: (changeIds = []) =>
      Effect.succeed({
        status: "read" as const,
        operationId: "0".repeat(128),
        head: revisions[0]!,
        revisions: changeIds.map((id) => revisions.find((revision) => revision.changeId === id)!)
      }),
    apply: () => Effect.die("a lander never applies native operations"),
    publishOriginalSource: () => Effect.die("a local lander never retains a source with the backend")
  })
  const lander = await Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => make({ kind: "fast-forward", repositoryPath: root, fs, environment }))
      .pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, native))
      )
  )
  return { root, main, revisions, lander }
}

test("green prefix: a stack longer than one process answer still advances main", async (t) => {
  // 1,200 rows are about 138 KiB of listing; a process answers 128 KiB.
  const { root, main, revisions, lander } = await longStack(t, 1_200)
  const passed = revisions[1_150] as unknown as Revision, failed = revisions[1_190] as unknown as Revision
  const receipts = [verdictOf(passed, "passed"), verdictOf(failed, "failed")]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts })), {
    status: "advanced",
    from: main,
    to: passed.commitId,
    above: 49
  })
  assert.equal(commitOf(root, "main"), passed.commitId)
})

test("green prefix: a merge where a page of a long stack ends stays on the line", async (t) => {
  const { root, main, revisions, lander } = await longStack(t, 1_200, 999)
  // The listing holds the merged-in side commit too; the tip is its last row.
  const tip = revisions.at(-1) as unknown as Revision
  assert.deepEqual(
    await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: [verdictOf(tip, "passed")] })),
    { status: "advanced", from: main, to: tip.commitId, above: 0 }
  )
  assert.equal(commitOf(root, "main"), tip.commitId)
})

test("green prefix: a line of exactly one page ends at main", async (t) => {
  const { main, revisions, lander } = await longStack(t, 1_000)
  const first = revisions[0] as unknown as Revision
  assert.deepEqual(
    await Effect.runPromise(
      lander.advanceGreenPrefix({ required, tip: "vibe", receipts: [verdictOf(first, "passed")] })
    ),
    { status: "advanced", from: main, to: first.commitId, above: 999 }
  )
})

/**
 * The shape a merge queue leaves once main's own commits are merged back into the stack:
 *
 *   base ── s1 ── s2 ── merge ── c1 ── c2 (vibe)
 *      └── m1 (main) ────┘
 *
 * Only `merge`, `c1` and `c2` descend from main; `s1` and `s2` reach main inside the merge.
 */
const mergedBackRepository = async (t: Cleanup) => {
  const root = await mkdtemp(join(tmpdir(), "coding-green-prefix-merged-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  jj(root, "git", "init")
  await writeFile(join(root, "a.txt"), "a\n")
  jj(root, "commit", "-m", "base")
  const commitOn = async (parents: ReadonlyArray<string>, name: string) => {
    jj(root, "new", ...parents, "-m", name)
    await writeFile(join(root, `${name}.txt`), `${name}\n`)
    jj(root, "new")
    return revisionOf(root, "@-")
  }
  const base = commitOf(root, "@-")
  const s1 = await commitOn([base], "s1"), s2 = await commitOn([s1.commitId], "s2")
  const m1 = await commitOn([base], "m1")
  jj(root, "bookmark", "create", "main", "-r", m1.commitId)
  const merge = await commitOn([s2.commitId, m1.commitId], "merge")
  const c1 = await commitOn([merge.commitId], "c1"), c2 = await commitOn([c1.commitId], "c2")
  jj(root, "bookmark", "create", "vibe", "-r", c2.commitId)
  return { root, main: m1.commitId, s1, s2, merge, c1, c2 }
}

test("green prefix: main merged back into the stack fast-forwards along the first-parent line", async (t) => {
  const { root, main, s1, s2, merge, c1, c2 } = await mergedBackRepository(t)
  const lander = await landerOf(root, "fast-forward")
  const advance = (receipts: ReadonlyArray<Receipt>) => lander.advanceGreenPrefix({ required, tip: "vibe", receipts })
  // s2 passed, but main cannot fast-forward to a commit that does not hold main.
  assert.deepEqual(await Effect.runPromise(advance([verdictOf(s2, "passed")])), {
    status: "unchanged",
    main,
    reason: "no passed commit above main"
  })
  // A failure the merge brought in fails the merge, and with it every commit above.
  const carried = [verdictOf(s1, "failed"), verdictOf(c1, "passed")]
  assert.deepEqual(await Effect.runPromise(advance(carried)), {
    status: "unchanged",
    main,
    reason: `${merge.commitId} merged a failed commit above main`
  })
  // Its receipt must still be its own tree's.
  const foreign = await failure(advance([verdictOf(s1, "failed", { treeId: c1.treeId }), verdictOf(c1, "passed")]))
  assert.equal(foreign.code, "invalid_receipt")
  assert.match(foreign.message, new RegExp(`${s1.commitId} .*tree`))
  assert.equal(commitOf(root, "main"), main)
  // An outage, a fast check, an unrequired check, a superseded failure and a commit outside the stack veto nothing.
  const cleared = [
    verdictOf(s1, "failed", { fault: "infra" }),
    verdictOf(s1, "failed", { tier: "fast" }),
    verdictOf(s1, "failed", { checkId: "bench" }),
    verdictOf(s2, "superseded"),
    verdictOf({ ...s1, commitId: "0".repeat(40) }, "failed"),
    verdictOf({ ...s1, commitId: "not a commit" }, "failed"),
    verdictOf(c1, "passed"),
    verdictOf(c2, "failed")
  ]
  assert.deepEqual(await Effect.runPromise(advance(cleared)), {
    status: "advanced",
    from: main,
    to: c1.commitId,
    above: 1
  })
  assert.equal(commitOf(root, "main"), c1.commitId)
  assert.deepEqual(filesOf(root, "main"), ["a.txt", "c1.txt", "m1.txt", "merge.txt", "s1.txt", "s2.txt"])
})

test("green prefix: a branch merged into the stack blocks from its merge up, not below", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const [c1, c2, c3, c4] = stack as [Revision, Revision, Revision, Revision]
  // side forks from main and joins the line in a merge above c4; old forks below main and joins above that.
  jj(root, "new", "main", "--no-edit", "-m", "side")
  const side = revisionOf(root, "description(exact:\"side\\n\")")
  jj(root, "new", "vibe", side.commitId, "--no-edit", "-m", "merge side")
  const first = revisionOf(root, "description(exact:\"merge side\\n\")")
  jj(root, "new", "main-", "--no-edit", "-m", "old")
  const old = revisionOf(root, "description(exact:\"old\\n\")")
  jj(root, "new", first.commitId, old.commitId, "--no-edit", "-m", "merge old")
  const second = revisionOf(root, "description(exact:\"merge old\\n\")")
  jj(root, "bookmark", "create", "merged", "-r", second.commitId)
  const lander = await landerOf(root, "fast-forward")
  const advance = (receipts: ReadonlyArray<Receipt>) => lander.advanceGreenPrefix({ required, tip: "merged", receipts })
  // side descends from main, yet it is not on the line: its pass moves nothing.
  assert.deepEqual(await Effect.runPromise(advance([verdictOf(side, "passed")])), {
    status: "unchanged",
    main,
    reason: "no passed commit above main"
  })
  // More failures than one listing names, most of them for commits this repository never had.
  const unknown = Array.from(
    { length: 1_000 },
    (_, index) => verdictOf({ ...side, commitId: index.toString(16).padStart(40, "f") }, "failed")
  )
  const blocked = [
    ...unknown,
    verdictOf(old, "failed"),
    // A command check records a real failure as fault factory; it blocks a merge like a fault-less one.
    verdictOf(side, "failed", { fault: "factory" }),
    verdictOf(c2, "passed"),
    verdictOf(second, "passed")
  ]
  assert.deepEqual(await Effect.runPromise(advance(blocked)), {
    status: "advanced",
    from: main,
    to: c2.commitId,
    above: 4
  })
  assert.deepEqual(await Effect.runPromise(advance(blocked)), {
    status: "unchanged",
    main: c2.commitId,
    reason: `${first.commitId} merged a failed commit above main`
  })
  // side's failure is superseded: old's still fails the second merge, so main stops under it.
  const later = [
    verdictOf(old, "failed"),
    verdictOf(side, "superseded"),
    verdictOf(first, "passed"),
    verdictOf(second, "passed")
  ]
  assert.deepEqual(await Effect.runPromise(advance(later)), {
    status: "advanced",
    from: c2.commitId,
    to: first.commitId,
    above: 1
  })
  assert.deepEqual(await Effect.runPromise(advance([verdictOf(second, "passed")])), {
    status: "advanced",
    from: first.commitId,
    to: second.commitId,
    above: 0
  })
  assert.deepEqual([c1, c3, c4].map((revision) => revision.commitId).every((id) => id !== commitOf(root, "main")), true)
})

test("green prefix: a failed commit below holds main under it, never moving backwards", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const lander = await landerOf(root, "fast-forward")
  const [c1, c2, c3, c4] = stack as [Revision, Revision, Revision, Revision]
  const blocked = [verdictOf(c1, "passed"), verdictOf(c2, "failed"), verdictOf(c4, "passed")]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: blocked })), {
    status: "advanced",
    from: main,
    to: c1.commitId,
    above: 3
  })
  // c1 failing a second check now does not pull main back.
  const later = [...blocked, verdictOf(c1, "failed")]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: later })), {
    status: "unchanged",
    main: c1.commitId,
    reason: `${c2.commitId} failed above main`
  })
  assert.equal(commitOf(root, "main"), c1.commitId)
  // An infra fault is no verdict: c2 now has only an outage, so the passes above count.
  const outage = [verdictOf(c2, "failed", { fault: "infra" }), verdictOf(c3, "passed"), verdictOf(c4, "superseded")]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: outage })), {
    status: "advanced",
    from: c1.commitId,
    to: c3.commitId,
    above: 1
  })
  // Nothing tested above main.
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: [] })), {
    status: "unchanged",
    main: c3.commitId,
    reason: "no passed commit above main"
  })
})

test("green prefix: a command check's real failure (fault factory) is a veto", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const lander = await landerOf(root, "fast-forward")
  const [c1, c2, c3] = stack as [Revision, Revision, Revision]
  // checks.ts records every ordinary nonzero exit as `fault: "factory"`: c1 failed, so c2's pass moves nothing.
  const below = [verdictOf(c1, "failed", { fault: "factory" }), verdictOf(c2, "passed")]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: below })), {
    status: "unchanged",
    main,
    reason: `${c1.commitId} failed above main`
  })
  assert.equal(commitOf(root, "main"), main)
  // A real failure stays a veto even beside a passing rerun of the same check on the same commit.
  const rerun = [
    verdictOf(c1, "passed"),
    verdictOf(c2, "failed", { fault: "factory" }),
    verdictOf(c2, "passed"),
    verdictOf(c3, "passed")
  ]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required, tip: "vibe", receipts: rerun })), {
    status: "advanced",
    from: main,
    to: c1.commitId,
    above: 3
  })
})

test("green prefix: refusals leave main where it is", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const lander = await landerOf(root, "fast-forward")
  const [c1, c2] = stack as [Revision, Revision]
  const before = jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id")
  // A receipt whose tree is not its commit's tree is not this commit's verdict.
  const foreign = await failure(
    lander.advanceGreenPrefix({ required, tip: "vibe", receipts: [verdictOf(c2, "passed", { treeId: c1.treeId })] })
  )
  assert.equal(foreign.code, "invalid_receipt")
  assert.match(foreign.message, new RegExp(`${c2.commitId} .*tree`))
  assert.equal(
    (await failure(lander.advanceGreenPrefix({ required, tip: "no-such", receipts: [] }))).code,
    "invalid_receipt"
  )
  assert.equal(jj(root, "op", "log", "-n", "1", "--no-graph", "-T", "id"), before, "nothing was written")
  // A tip that does not descend from main: main only fast-forwards.
  jj(root, "new", "main-", "--no-edit", "-m", "elsewhere")
  jj(root, "bookmark", "create", "side", "-r", "description(exact:\"elsewhere\\n\")")
  const sideways = await failure(lander.advanceGreenPrefix({ required, tip: "side", receipts: [] }))
  assert.equal(sideways.code, "stale_revision")
  assert.equal(commitOf(root, "main"), main)
  const pullRequest = await landerOf(root, "pull-request")
  assert.equal(
    (await failure(pullRequest.advanceGreenPrefix({ required, tip: "vibe", receipts: [] }))).code,
    "unavailable"
  )
})

test("green prefix: a commit is green once every required check passed on it", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const lander = await landerOf(root, "fast-forward")
  const [c1, c2, c3] = stack as [Revision, Revision, Revision]
  const both = ["test", "lint"]
  const lint = { checkId: "lint" }
  // Only one of two required checks has run on c1: not green yet.
  assert.deepEqual(
    await Effect.runPromise(
      lander.advanceGreenPrefix({ required: both, tip: "vibe", receipts: [verdictOf(c1, "passed")] })
    ),
    { status: "unchanged", main, reason: "no passed commit above main" }
  )
  const receipts = [
    verdictOf(c1, "passed"),
    verdictOf(c1, "passed", { ...lint, tier: "delivery" }),
    // An outage, then the rerun's pass: the check passed.
    verdictOf(c2, "failed", { fault: "infra" }),
    verdictOf(c2, "passed"),
    verdictOf(c2, "passed", lint),
    // A check nobody requires does not block.
    verdictOf(c2, "failed", { checkId: "bench" }),
    // An outage alone is no verdict: c3 is untested for lint.
    verdictOf(c3, "passed"),
    verdictOf(c3, "failed", { ...lint, fault: "infra" })
  ]
  assert.deepEqual(await Effect.runPromise(lander.advanceGreenPrefix({ required: both, tip: "vibe", receipts })), {
    status: "advanced",
    from: main,
    to: c2.commitId,
    above: 2
  })
  assert.equal(
    (await failure(lander.advanceGreenPrefix({ required: [], tip: "vibe", receipts }))).code,
    "invalid_receipt"
  )
})

test("green prefix: a stack that changes while it is read never pulls main wrongly", async (t) => {
  const { root, main, stack } = await stackRepository(t)
  const c3 = stack[2]!
  const receipts = [verdictOf(c3, "passed")]
  // The green commit is rewritten after its tree was read: its old commit is hidden.
  const rewritten = await landerOf(root, "fast-forward", environment, () => {
    jj(root, "describe", "-r", c3.commitId, "-m", "✨ feat: c3, reworded")
  })
  const gone = await failure(rewritten.advanceGreenPrefix({ required, tip: "vibe", receipts }))
  assert.equal(gone.code, "evicted")
  assert.match(gone.message, /left the stack/)
  assert.equal(commitOf(root, "main"), main)
  // Another advance moved main past the green commit first: nothing to do.
  const { root: other, stack: second } = await stackRepository(t)
  const raced = await landerOf(other, "fast-forward", environment, () => {
    jj(other, "bookmark", "set", "main", "-r", second[3]!.commitId)
  })
  assert.deepEqual(
    await Effect.runPromise(
      raced.advanceGreenPrefix({ required, tip: "vibe", receipts: [verdictOf(second[2]!, "passed")] })
    ),
    { status: "unchanged", main: second[3]!.commitId, reason: `main already holds ${second[2]!.commitId}` }
  )
})
