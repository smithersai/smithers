/**
 * Publishing a rewritten stack: the local lander pushes the stack's tip to a
 * branch on a real bare remote with a lease on the branch's expected old head,
 * then fetches it back and confirms every rewritten Change is that exact
 * commit on the published branch.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { StackPublicationInput } from "../coding/landing-schema.vibe"
import { Landing, type LocalLanding } from "../coding/landing.ts"
import { make } from "../coding/local-landing.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { PublishStack, stackPublicationLayers } from "../coding/vibe-publication.ts"

const environment: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? tmpdir(),
  JJ_USER: "Smithers Test",
  JJ_EMAIL: "smithers@example.test",
  JJ_CONFIG: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
}
const sh = (cwd: string, file: string, args: ReadonlyArray<string>) =>
  execFileSync(file, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const jj = (cwd: string, ...args: string[]) => sh(cwd, "jj", ["--no-pager", "--color=never", ...args])
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", args)
const commitOf = (cwd: string, revset: string) => jj(cwd, "log", "--no-graph", "-r", revset, "-T", "commit_id")
const changeOf = (cwd: string, revset: string) => jj(cwd, "log", "--no-graph", "-r", revset, "-T", "change_id")
const remoteHead = (remote: string, branch: string) => {
  try {
    return sh(remote, "git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  } catch {
    return null
  }
}
type Cleanup = { after: (fn: () => Promise<void>) => void }

/** main ← first ← second, two Changes of a stack, with a bare `origin` that has no `vibe` yet. */
const repository = async (t: Cleanup) => {
  const root = await mkdtemp(join(tmpdir(), "coding-publish-stack-"))
  const remote = `${root}-remote.git`
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(remote, { recursive: true, force: true }))
  jj(root, "git", "init")
  git(root, "init", "--bare", remote)
  jj(root, "git", "remote", "add", "origin", remote)
  await writeFile(join(root, "a.txt"), "a\n")
  jj(root, "commit", "-m", "base")
  jj(root, "bookmark", "create", "main", "-r", "@-")
  await writeFile(join(root, "first.txt"), "first\n")
  jj(root, "commit", "-m", "✨ feat: first")
  await writeFile(join(root, "second.txt"), "second\n")
  jj(root, "commit", "-m", "✨ feat: second")
  const changes = [changeOf(root, "@--"), changeOf(root, "@-")]
  return { root, remote, changes }
}
/** The stack as it is now: each Change's current commit, and the tip. */
const stackOf = (root: string, changes: ReadonlyArray<string>) => ({
  tip: commitOf(root, `change_id("${changes.at(-1)}")`),
  changes: changes.map((changeId) => ({ changeId, commitId: commitOf(root, `change_id("${changeId}")`) }))
})
const unusedNative = Layer.succeed(NativeCoding, {
  sourcePublication: "local-only",
  read: () => Effect.die("publication reads jj directly"),
  apply: () => Effect.die("publication never applies native operations"),
  publishOriginalSource: () => Effect.die("publication never retains a source with the backend")
})
const landerOf = (root: string, env = environment) =>
  Effect.runPromise(
    Effect.flatMap(
      FileSystem.FileSystem,
      (fs) => make({ kind: "fast-forward", repositoryPath: root, fs, environment: env })
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, unusedNative)))
  )
const failure = <A>(effect: Effect.Effect<A, CodingError>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => {
    assert.ok(error instanceof CodingError)
    return error
  })

test("stack publication: a rewritten stack replaces the branch under a lease and is confirmed", async (t) => {
  const { root, remote, changes } = await repository(t)
  const lander: LocalLanding = await landerOf(root)
  const first = stackOf(root, changes)
  const input: StackPublicationInput = { branch: "vibe", expected: null, ...first }
  const published = await Effect.runPromise(lander.publishStack(input))
  assert.deepEqual(published, {
    remote: "origin",
    branch: "vibe",
    previous: null,
    head: first.tip,
    changes: first.changes
  })
  assert.equal(remoteHead(remote, "vibe"), first.tip)
  assert.equal(commitOf(root, "vibe"), first.tip, "the local bookmark tracks the published head")
  assert.equal(
    jj(root, "log", "--no-graph", "-r", "immutable() & ::vibe ~ ::main", "-T", "commit_id"),
    "",
    "the stack stays mutable"
  )

  // Amending the first Change in place rewrites it and every descendant.
  jj(root, "describe", "-r", changes[0]!, "-m", "✨ feat: first, amended")
  const rewritten = stackOf(root, changes)
  assert.notEqual(rewritten.tip, first.tip)
  assert.ok(rewritten.changes.every((change, index) => change.commitId !== first.changes[index]!.commitId))
  const republished = await Effect.runPromise(
    lander.publishStack({ branch: "vibe", expected: first.tip, ...rewritten })
  )
  assert.deepEqual(republished, {
    remote: "origin",
    branch: "vibe",
    previous: first.tip,
    head: rewritten.tip,
    changes: rewritten.changes
  })
  assert.equal(remoteHead(remote, "vibe"), rewritten.tip, "the rewritten tip replaced the old one")

  // A lost reply replays: the branch already holds the tip, so it is confirmed again without a lease failure.
  assert.deepEqual(
    await Effect.runPromise(lander.publishStack({ branch: "vibe", expected: first.tip, ...rewritten })),
    republished
  )
})

test("stack publication: a branch that moved away from the expected head is never pushed over", async (t) => {
  const { root, remote, changes } = await repository(t)
  const lander = await landerOf(root)
  const stack = stackOf(root, changes)
  await Effect.runPromise(lander.publishStack({ branch: "vibe", expected: null, ...stack }))
  // Someone else publishes the first Change only.
  git(root, "push", "--force", remote, `${stack.changes[0]!.commitId}:refs/heads/vibe`)
  jj(root, "describe", "-r", changes[1]!, "-m", "✨ feat: second, amended")
  const rewritten = stackOf(root, changes)
  const stale = await failure(lander.publishStack({ branch: "vibe", expected: stack.tip, ...rewritten }))
  assert.equal(stale.code, "evicted")
  assert.match(stale.message, new RegExp(`vibe@origin moved from ${stack.tip} to ${stack.changes[0]!.commitId}`))
  assert.equal(remoteHead(remote, "vibe"), stack.changes[0]!.commitId, "the other writer's head stands")
  // A first publication expects no branch at all.
  const exists = await failure(lander.publishStack({ branch: "vibe", expected: null, ...rewritten }))
  assert.equal(exists.code, "evicted")
  assert.equal(remoteHead(remote, "vibe"), stack.changes[0]!.commitId)
})

test("stack publication: refusals before anything is pushed", async (t) => {
  const { root, remote, changes } = await repository(t)
  const lander = await landerOf(root)
  const before = stackOf(root, changes)
  jj(root, "describe", "-r", changes[0]!, "-m", "✨ feat: first, amended")
  const after = stackOf(root, changes)
  // A Change named at its pre-rewrite commit is not on the stack being published.
  const old = await failure(
    lander.publishStack({ branch: "vibe", expected: null, tip: after.tip, changes: before.changes })
  )
  assert.equal(old.code, "invalid_receipt")
  assert.match(
    old.message,
    new RegExp(`${changes[0]} is ${after.changes[0]!.commitId} on the stack, not ${before.changes[0]!.commitId}`)
  )
  for (const branch of ["-vibe", "vibe..x", "refs/heads/vibe", "vibe~1", ""]) {
    assert.equal((await failure(lander.publishStack({ branch, expected: null, ...after }))).code, "invalid_receipt")
  }
  assert.equal(
    (await failure(lander.publishStack({ branch: "vibe", remote: "no-such", expected: null, ...after }))).code,
    "unavailable"
  )
  assert.equal(remoteHead(remote, "vibe"), null, "nothing was published")
})

test("stack publication: a conflicted stack is refused before the push", async (t) => {
  const { root, remote, changes } = await repository(t)
  // Someone else's first.txt under the stack makes both Changes conflicted.
  jj(root, "new", "main", "--no-edit", "-m", "other first")
  const other = changeOf(root, `description(exact:"other first\\n")`)
  const scratch = await mkdtemp(join(tmpdir(), "coding-publish-stack-edit-"))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  jj(root, "workspace", "add", "--name", "other", "-r", other, scratch)
  jj(scratch, "edit", other)
  await writeFile(join(scratch, "first.txt"), "someone else's first\n")
  jj(scratch, "status")
  jj(root, "workspace", "forget", "other")
  jj(root, "rebase", "-s", changes[0]!, "-d", other)
  const stack = stackOf(root, changes)
  const error = await failure((await landerOf(root)).publishStack({ branch: "vibe", expected: null, ...stack }))
  assert.equal(error.code, "invalid_receipt")
  assert.match(error.message, /conflicted commits/)
  assert.equal(remoteHead(remote, "vibe"), null, "nothing was published")
})

test("stack publication: an obsolete tip and a remote that declines are refused", async (t) => {
  const { root, remote, changes } = await repository(t)
  const before = stackOf(root, changes)
  jj(root, "describe", "-r", changes[1]!, "-m", "✨ feat: second, amended")
  // The pre-rewrite tip still resolves by its full id, hidden.
  const obsolete = await failure((await landerOf(root)).publishStack({
    branch: "vibe",
    expected: null,
    tip: before.tip,
    changes: before.changes.slice(0, 1)
  }))
  assert.equal(obsolete.code, "invalid_receipt")
  assert.match(obsolete.message, /rewritten or abandoned/)
  await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n")
  await chmod(join(remote, "hooks", "pre-receive"), 0o755)
  const declined = await failure(
    (await landerOf(root)).publishStack({ branch: "vibe", expected: null, ...stackOf(root, changes) })
  )
  assert.equal(declined.code, "unavailable")
  assert.match(declined.message, /git push refused/)
  assert.equal(remoteHead(remote, "vibe"), null)
})

test("stack publication: any named remote", async (t) => {
  const { root, remote, changes } = await repository(t)
  jj(root, "git", "remote", "add", "upstream", remote)
  const stack = stackOf(root, changes)
  const published = await Effect.runPromise(
    (await landerOf(root)).publishStack({ branch: "stack/vibe", remote: "upstream", expected: null, ...stack })
  )
  assert.equal(published.remote, "upstream")
  assert.equal(remoteHead(remote, "stack/vibe"), stack.tip)
  assert.equal(commitOf(root, "stack/vibe@upstream"), stack.tip)
})

for (const workspaceFetches of [false, true]) {
  test(`stack publication: a writer moving the branch just before the push loses the lease (workspace fetches: ${workspaceFetches})`, async (t) => {
    const { root, remote, changes } = await repository(t)
    const stack = stackOf(root, changes)
    await Effect.runPromise((await landerOf(root)).publishStack({ branch: "vibe", expected: null, ...stack }))
    jj(root, "describe", "-r", changes[1]!, "-m", "✨ feat: second, amended")
    const rewritten = stackOf(root, changes)
    // Another writer lands just before the push: whichever of `jj` and `git` pushes first moves the
    // remote branch, and may also fetch it into this repository (an editor, a hook, another tool).
    const bin = `${root}-bin`
    t.after(() => rm(bin, { recursive: true, force: true }))
    await mkdir(bin)
    const realGit = sh(root, "sh", ["-c", "command -v git"]), realJj = sh(root, "sh", ["-c", "command -v jj"])
    const fetch = workspaceFetches
      ? `"${realGit}" -C "${root}" fetch "${remote}" +refs/heads/vibe:refs/remotes/origin/vibe`
      : ":"
    for (const [name, real] of [["git", realGit], ["jj", realJj]] as const) {
      await writeFile(
        join(bin, name),
        `#!/bin/sh
case " $* " in *" push "*) if [ ! -e "${bin}/raced" ]; then : > "${bin}/raced"
  "${realGit}" --git-dir "${remote}" update-ref refs/heads/vibe ${stack.changes[0]!.commitId}; ${fetch}; fi ;; esac
exec "${real}" "$@"
`
      )
      await chmod(join(bin, name), 0o755)
    }
    const racing = await landerOf(root, { ...environment, PATH: `${bin}:${environment.PATH}` })
    const lost = await failure(racing.publishStack({ branch: "vibe", expected: stack.tip, ...rewritten }))
    assert.equal(lost.code, "evicted")
    assert.match(lost.message, /vibe@origin moved during publication/)
    assert.equal(remoteHead(remote, "vibe"), stack.changes[0]!.commitId, "the racing writer's head stands")
  })
}

test("stack publication: coding/PublishStack journals the confirmed receipt", async (t) => {
  const { root, remote, changes } = await repository(t)
  const stack = stackOf(root, changes)
  const lander = await landerOf(root)
  const host = ManagedRuntime.make(
    stackPublicationLayers.pipe(
      Layer.provide(Layer.succeed(Landing, lander)),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  t.after(() => host.dispose())
  const input = { branch: "vibe", expected: null, ...stack }
  const receipt = await host.runPromise(PublishStack.execute(input, { executionId: "publish-1" }))
  assert.equal(receipt.head, stack.tip)
  assert.equal(remoteHead(remote, "vibe"), stack.tip)
  // The branch moves on; the same execution answers its journaled receipt and pushes nothing.
  git(root, "push", "--force", remote, `${stack.changes[0]!.commitId}:refs/heads/vibe`)
  assert.deepEqual(await host.runPromise(PublishStack.execute(input, { executionId: "publish-1" })), receipt)
  assert.equal(remoteHead(remote, "vibe"), stack.changes[0]!.commitId)
  // A new execution with a stale lease is refused.
  const exit = await host.runPromise(Effect.flip(PublishStack.execute(input, { executionId: "publish-2" })))
  assert.ok(exit instanceof CodingError)
  assert.equal(exit.code, "evicted")
})

test("stack publication: a backend host refuses", async () => {
  const backend = { kind: "backend" } as unknown as LocalLanding
  const host = ManagedRuntime.make(
    stackPublicationLayers.pipe(
      Layer.provide(Layer.succeed(Landing, backend)),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  const tip = "a".repeat(40)
  const error = await host.runPromise(Effect.flip(PublishStack.execute(
    { branch: "vibe", expected: null, tip, changes: [{ changeId: "k".repeat(32), commitId: tip }] },
    { executionId: "backend" }
  )))
  await host.dispose()
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "unavailable")
})
