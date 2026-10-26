// Resync (worker/branch/Resync.ts, docs/features/branch-publish.md#resync): a published branch's Smithers branch and
// working copy follow the head its GitHub branch reached. GitHub is a real repository the test commits to, Code Storage
// a bare repository the machine fetches the Smithers branch from (the test's `Forge` moves its ref, and syncs it from
// GitHub when asked), and the machine a real checkout whose tools run `@smthrs/sandbox`'s real scripts and real git
// (worker/test/box.ts). Postgres is the file's own schema. Faults are injected services: a `Forge` that refuses or
// can't answer, and a `Machines` that fails one call or saves a file between the plan and the apply.
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { SandboxTools } from "@smthrs/sandbox"
import { SharedText } from "@smthrs/sync"
import { Cause, Effect, Exit, Layer, Metric, Redacted } from "effect"
import { Base64 } from "effect/encoding"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import type { SqlClient } from "effect/sql"
import { resyncExecutionId } from "../../src/features/branch/contract.ts"
import { TEXT_NAMESPACE, textName } from "../../src/features/coedit/contract.ts"
import { SAVED_MARK, savedMarkOf } from "../../src/features/coedit/saved.ts"
import { admit, database, REPOSITORY, reset, services, signedIn, sql, writeRow } from "../github/test/fixtures.ts"
import { type ScriptedGitHub, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as Box from "../test/box.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Conversations from "./Conversations.ts"
import { CreateRefused, Forge } from "./Forge.ts"
import { Machines } from "./Machines.ts"
import * as Publish from "./Publish.ts"
import * as Resync from "./Resync.ts"
import { CheckoutFailed, SandboxUnavailable } from "./Sandboxes.ts"
import * as Store from "../github/Store.ts"

const runtime = testFile("branch_resync")
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE branch_publications, text_updates, branches CASCADE")
})

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-resync-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

const has = (repository: string, sha: string) => {
  try {
    git(repository, "cat-file", "-e", `${sha}^{commit}`)
    return true
  } catch {
    return false
  }
}

/** The GitHub branch Publish made for `try-1`. */
const REF = "try-1-0123456789ab"
const GUIDE = "docs/guide.md"

const write = (directory: string, files: Readonly<Record<string, string>>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
}

let worlds = 0
/**
 * GitHub with `main` at `base` (README.md, docs/guide.md); Code Storage holding `main` and the Smithers branch `try-1`
 * at `base`; the machine's checkout of `try-1`. The forge moves Code Storage's `try-1` to a commit it holds, refuses
 * one it doesn't (`not_found`), and syncs every GitHub branch into it on `pull`.
 */
const world = () => {
  const dir = join(root, `world-${++worlds}`)
  const github = join(dir, "github")
  mkdirSync(github, { recursive: true })
  git(github, "init", "-q", "-b", "main")
  write(github, { "README.md": "# Widgets\n", [GUIDE]: "one\ntwo\nthree\n" })
  git(github, "add", "-A")
  git(github, "commit", "-q", "-m", "base")
  const base = git(github, "rev-parse", "HEAD")
  const storage = join(dir, "storage.git")
  git(dir, "init", "-q", "--bare", "storage.git")
  git(github, "push", "-q", storage, `${base}:refs/heads/main`, `${base}:refs/heads/try-1`)
  const workdir = join(dir, "machine")
  execFileSync("git", ["clone", "-q", "--branch", "try-1", "--single-branch", storage, workdir])
  const box = Box.boxAt({ workdir, homes: join(dir, "homes") })
  const calls: Array<string> = []
  const sync = () => void git(github, "push", "-q", "-f", storage, "refs/heads/*:refs/mirror/*")
  const forge = Forge.of({
    upstream: () => Effect.die("resync reads no forge"),
    create: () => Effect.die("resync creates no branch"),
    move: (_repository, branch, to) =>
      Effect.suspend(() => {
        calls.push(`move ${branch}`)
        if (!has(storage, to)) return Effect.fail(new CreateRefused({ code: "not_found" }))
        git(storage, "update-ref", `refs/heads/${branch}`, to)
        return Effect.void
      }),
    pull: () =>
      Effect.sync(() => {
        calls.push("pull")
        sync()
      }),
  })
  const machines = Box.machinesOn(box.box)
  return {
    github,
    storage,
    workdir,
    box,
    base,
    calls,
    sync,
    forge,
    machines,
    layer: (overrides: { readonly machines?: Machines["Service"]; readonly forge?: Forge["Service"] } = {}) =>
      Layer.merge(Layer.succeed(Machines, overrides.machines ?? machines), Layer.succeed(Forge, overrides.forge ?? forge)),
    read: (path: string) => readFileSync(join(workdir, path), "utf8"),
    head: () => git(workdir, "rev-parse", "HEAD"),
    status: () => git(workdir, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean).sort(),
  }
}
type World = ReturnType<typeof world>

/** On GitHub: Publish's branch `REF` at `base` plus `files`, as the working copy held them at its push. */
const published = (w: World, files: Readonly<Record<string, string>>) => {
  git(w.github, "checkout", "-q", "-b", REF, w.base)
  write(w.github, files)
  git(w.github, "add", "-A")
  git(w.github, "commit", "-q", "-m", "Add a line")
  return git(w.github, "rev-parse", "HEAD")
}

/** On GitHub: `main` moves with `files`, then Update branch merges it into `REF`. Answers the merge. */
const updated = (w: World, files: Readonly<Record<string, string>>) => {
  git(w.github, "checkout", "-q", "main")
  write(w.github, files)
  git(w.github, "add", "-A")
  git(w.github, "commit", "-q", "-m", "main moves")
  git(w.github, "checkout", "-q", REF)
  git(w.github, "merge", "-q", "--no-edit", "main")
  return git(w.github, "rev-parse", "HEAD")
}

/** Maya, signed in, owns the Smithers-only branch `try-1`, made at `base`; its publication heads at `head`. */
const tracked = async (w: World, head: string, github: ScriptedGitHub = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)) => {
  const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
  const made = await runtime.runPromise(
    Conversations.track(REPOSITORY.id, "try-1", "open", w.base, maya.personId, undefined, "ephemeral", "deployment"),
  )
  const branchId = made.branch.branchId
  await sql(runtime, `
    INSERT INTO branch_publications (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pr_number, write_id, pushed, pushed_sha)
    VALUES ('${branchId}', '${REPOSITORY.id}', '${REF}', 'main', '${w.base}', '${head}', 1, '${crypto.randomUUID()}',
      '{"README.md":"pushed"}', '${head}')`)
  return { github, maya, branchId, conversationId: made.branch.conversationId }
}
type Tracked = Awaited<ReturnType<typeof tracked>>

const publication = async (branchId: string) =>
  ((await sql(runtime, `SELECT synced_sha AS "syncedSha", head_sha AS "headSha", pushed_sha AS "pushedSha", pushed,
    sync_state AS state, sync_conflicts AS conflicts, syncing FROM branch_publications WHERE branch_id = '${branchId}'`)) as unknown as Array<
      Record<string, unknown>
    >)[0]

/** Postgres that never answers: nothing listens on port 1. */
const DOWN = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))

/** Runs the resync of `t`'s branch onto `onto` with `layer`, on the file's schema or `on`, under a metric registry of its own. */
const resyncing = async (
  t: Tracked,
  onto: string,
  layer: Layer.Layer<Machines | Forge>,
  key: string = crypto.randomUUID(),
  on?: Layer.Layer<SqlClient.SqlClient, unknown>,
) => {
  const registry: Metric.MetricRegistry = new Map()
  const live = await database(runtime)
  const read = await runtime.runPromise(Effect.gen(function* () {
    return { branch: (yield* Publish.branchOf(t.branchId))!, publication: (yield* Publish.publicationOf(t.branchId))! }
  }).pipe(Effect.provide(live)))
  const exit = await runtime.runPromiseExit(
    Resync.resync({ ...read, repository: REPOSITORY, onto, actorId: t.maya.personId, key }).pipe(
      Effect.provide(layer),
      Effect.provide(on ?? live),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const counted = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(Resync.resyncs, { outcome })).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
  return { exit, counted }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

const textIdOf = (t: Tracked, path: string) =>
  Effect.runPromise(
    Uuid.v5(TEXT_NAMESPACE, textName({ kind: "file", conversation: t.conversationId, path })).pipe(Effect.provide(WebCrypto.layer)),
  )

const insertUpdate = (t: Tracked, textId: string, update: Uint8Array, seed = false) =>
  sql(runtime, `
    INSERT INTO text_updates (id, scope, text_id, data, seed, person_id)
    VALUES ('${crypto.randomUUID()}', 'branch:${t.branchId}', '${textId}', '${Base64.encode(update)}', ${seed}, 'p')`)

/** File `path`'s text as someone opened it, seeded with `content`; saved as it was, or typed in to `typed` and not saved. */
const opened = async (t: Tracked, path: string, content: string, options: { readonly saved?: boolean; readonly typed?: string } = {}) => {
  const textId = await textIdOf(t, path)
  await insertUpdate(t, textId, SharedText.seed(content), true)
  const updates = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const replica = yield* SharedText.make
    yield* replica.apply(SharedText.seed(content))
    const mark = options.saved === true ? yield* replica.mark(SAVED_MARK, savedMarkOf(content)) : undefined
    const typed = options.typed === undefined ? undefined : yield* replica.replace(options.typed)
    return [mark, typed].filter((update): update is Uint8Array => update !== undefined)
  })))
  for (const update of updates) await insertUpdate(t, textId, update)
  return textId
}

/** A text's replica, every update Postgres holds applied, given to `use`. */
const withText = async <A>(textId: string, use: (replica: SharedText.SharedText) => Effect.Effect<A>) => {
  const rows = (await sql(runtime, `SELECT data FROM text_updates WHERE text_id = '${textId}'`)) as unknown as Array<{ data: string }>
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const replica = yield* SharedText.make
    for (const row of rows) {
      const decoded = Base64.decode(row.data)
      if (decoded._tag === "Success") yield* Effect.orDie(replica.apply(decoded.success))
    }
    return yield* use(replica)
  })))
}

/** A text as every device reads it: its contents and its `saved` mark. */
const textOf = (textId: string) =>
  withText(textId, (replica) =>
    Effect.gen(function* () {
      return { content: yield* replica.text, saved: (yield* replica.marks).get(SAVED_MARK) }
    }))

/** Someone's Save of the text as `content`: its `saved` mark, as the editor sets it. */
const marked = async (t: Tracked, textId: string, content: string) =>
  insertUpdate(t, textId, (await withText(textId, (replica) => replica.mark(SAVED_MARK, savedMarkOf(content))))!)

/** Someone types in the text, to `next`, without saving. */
const typed = async (t: Tracked, textId: string, next: string) =>
  insertUpdate(t, textId, (await withText(textId, (replica) => replica.replace(next)))!)

describe("resync", { timeout: 60_000 }, () => {
  test("after Update branch: the Smithers branch and the working copy reach GitHub's head; the working copy's own changes stay", async () => {
    const w = world()
    // Saved and published as it is, then a new file the push didn't take, and a commit made in the terminal.
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n", "notes.md": "mine\n" })
    write(w.workdir, { "local.md": "terminal\n" })
    git(w.workdir, "add", "local.md")
    git(w.workdir, "commit", "-q", "-m", "terminal")
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    w.sync()
    const t = await tracked(w, head)
    const { counted, exit } = await resyncing(t, head, w.layer())
    expect(exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(w.head()).toBe(head)
    expect([w.read(GUIDE), w.read("README.md"), w.read("notes.md"), w.read("local.md")])
      .toEqual(["one\ntwo main\nthree\n", "# Widgets\n\nA line\n", "mine\n", "terminal\n"])
    expect(w.status()).toEqual(["?? local.md", "?? notes.md"])
    expect(git(w.storage, "rev-parse", "refs/heads/try-1")).toBe(head)
    expect(w.calls).toEqual(["move try-1"])
    expect(await publication(t.branchId)).toEqual({
      syncedSha: head,
      headSha: head,
      pushedSha: head,
      pushed: {},
      state: "synced",
      conflicts: null,
      syncing: null,
    })
    expect(counted("synced")).toBe(1)
    // Again: there already, and nothing moves.
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(w.status()).toEqual(["?? local.md", "?? notes.md"])
  })

  test("a file the working copy and GitHub both changed stops it, listed, with nothing changed", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n", [GUIDE]: "one\ntwo mine\nthree\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    w.sync()
    const t = await tracked(w, head)
    const { counted, exit } = await resyncing(t, head, w.layer())
    expect(exit).toEqual(Exit.succeed({ state: "conflict", paths: [GUIDE] }))
    expect(w.head()).toBe(w.base)
    expect(w.read(GUIDE)).toBe("one\ntwo mine\nthree\n")
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: null, state: "conflict", conflicts: [GUIDE], pushed: { "README.md": "pushed" } })
    expect(counted("conflict")).toBe(1)
    // Resolved by hand as main has it: the next resync goes through, and the conflict is gone.
    write(w.workdir, { [GUIDE]: "one\ntwo main\nthree\n" })
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: head, state: "synced", conflicts: null })
  })

  test("a history GitHub rewrote with nothing in common is a conflict listing no file", async () => {
    const w = world()
    git(w.github, "checkout", "-q", "--orphan", REF)
    write(w.github, { "other.md": "o\n" })
    git(w.github, "add", "-A")
    git(w.github, "commit", "-q", "-m", "rewritten")
    const head = git(w.github, "rev-parse", "HEAD")
    w.sync()
    const t = await tracked(w, head)
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "conflict", paths: [] }))
    expect(w.head()).toBe(w.base)
  })

  test("co-edited files: a saved text follows the file, an unsaved one GitHub changed stops it, others stay as they are", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n", "docs/new.md": "new\n" })
    w.sync()
    const t = await tracked(w, head)
    // Someone typed in the guide's text and didn't save: GitHub changed the guide, so the resync stops before anything.
    const guide = await opened(t, GUIDE, "one\ntwo\nthree\n", { typed: "one\ntwo\nthree\nfour\n" })
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "conflict", paths: [GUIDE] }))
    expect(w.head()).toBe(w.base)
    expect((await textOf(guide)).content).toBe("one\ntwo\nthree\nfour\n")

    // Saved, it is the working copy's: the merge takes main's change into it, and every editor still says Saved.
    write(w.workdir, { [GUIDE]: "one\ntwo\nthree\nfour\n" })
    await marked(t, guide, "one\ntwo\nthree\nfour\n")
    // README's text is open, saved, and GitHub didn't change it: it stays as it is.
    const readme = await opened(t, "README.md", "# Widgets\n\nA line\n", { saved: true })
    // Someone opened the file main adds before the working copy had it: empty, it takes main's contents.
    const fresh = await opened(t, "docs/new.md", "")
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(w.read(GUIDE)).toBe("one\ntwo main\nthree\nfour\n")
    expect(await textOf(guide)).toEqual({ content: "one\ntwo main\nthree\nfour\n", saved: savedMarkOf("one\ntwo main\nthree\nfour\n") })
    expect(await textOf(readme)).toEqual({ content: "# Widgets\n\nA line\n", saved: savedMarkOf("# Widgets\n\nA line\n") })
    expect(await textOf(fresh)).toEqual({ content: "new\n", saved: undefined })
  })

  test("a text opened and never saved follows the file without a saved mark; one for a file GitHub deleted empties", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    git(w.github, "checkout", "-q", "main")
    git(w.github, "rm", "-q", GUIDE)
    git(w.github, "commit", "-q", "-m", "drop the guide")
    git(w.github, "checkout", "-q", REF)
    git(w.github, "merge", "-q", "--no-edit", "main")
    const head = git(w.github, "rev-parse", "HEAD")
    w.sync()
    const t = await tracked(w, head)
    const guide = await opened(t, GUIDE, "one\ntwo\nthree\n")
    // A row that isn't an update is no text's content.
    await sql(runtime, `
      INSERT INTO text_updates (id, scope, text_id, data, person_id)
      VALUES ('${crypto.randomUUID()}', 'branch:${t.branchId}', '${guide}', '!!not base64', 'p')`)
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(existsSync(join(w.workdir, GUIDE))).toBe(false)
    expect(await textOf(guide)).toEqual({ content: "", saved: undefined })
  })

  test("a mirror behind GitHub is asked to sync, and the next attempt goes through", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    const t = await tracked(w, head)
    const first = await resyncing(t, head, w.layer())
    expect(failureOf(first.exit)).toEqual(new Resync.ResyncUnavailable({ retryAfterMillis: Resync.MIRROR_WAIT_MS }))
    expect(w.calls).toEqual(["move try-1", "pull"])
    expect(first.counted("unavailable")).toBe(1)
    expect(w.head()).toBe(w.base)
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    // A mirror that can't sync is logged, and the resync still waits for it.
    const stuck = Forge.of({ ...w.forge, move: () => Effect.fail(new CreateRefused({ code: "not_found" })), pull: () => Effect.fail(new CreateRefused({ code: "forbidden", errorCode: "insufficient_scope" })) })
    expect(failureOf((await resyncing(t, head, w.layer({ forge: stuck }))).exit)).toEqual(
      new Resync.ResyncUnavailable({ retryAfterMillis: Resync.MIRROR_WAIT_MS }),
    )
  })

  test("a forge that refuses is refused; one that doesn't answer, or a machine that doesn't, is tried again", async () => {
    const w = world()
    const head = published(w, { "README.md": "# Widgets\n\nA line\n" })
    w.sync()
    const t = await tracked(w, head)
    const refusing = (code: CreateRefused["code"]) => Forge.of({ ...w.forge, move: () => Effect.fail(new CreateRefused({ code })) })
    expect(failureOf((await resyncing(t, head, w.layer({ forge: refusing("forbidden") }))).exit)).toEqual(new Resync.ResyncRefused({ failure: "invalid" }))
    expect(failureOf((await resyncing(t, head, w.layer({ forge: refusing("not_configured") }))).exit)).toEqual(new Resync.ResyncRefused({ failure: "invalid" }))
    expect(failureOf((await resyncing(t, head, w.layer({ forge: refusing("unavailable") }))).exit)).toEqual(new Resync.ResyncUnavailable({}))
    const down = Machines.of({ ...w.machines, tool: () => Effect.fail(new SandboxUnavailable({ reason: "exec" })) })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: down }))).exit)).toEqual(new Resync.ResyncUnavailable({}))
    const unchecked = Machines.of({ ...w.machines, tool: () => Effect.fail(new CheckoutFailed()) })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: unchecked }))).exit)).toEqual(new Resync.ResyncRefused({ failure: "invalid" }))
    const refused = Machines.of({ ...w.machines, tool: () => Effect.fail(new SandboxTools.ToolRefused({ reason: "path" })) })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: refused }))).exit)).toEqual(new Resync.ResyncRefused({ failure: "invalid" }))
    // A move that didn't take: the machine's fetch doesn't find GitHub's head yet, so the resync is tried again.
    git(w.storage, "update-ref", "refs/heads/try-1", w.base)
    const stale = Forge.of({ ...w.forge, move: () => Effect.void })
    expect(failureOf((await resyncing(t, head, w.layer({ forge: stale }))).exit)).toEqual(new Resync.ResyncUnavailable({}))
    // More changed paths than one read lists.
    const cut = Machines.of({
      ...w.machines,
      tool: (branch, ownerId, callId, call) =>
        Effect.map(w.machines.tool(branch, ownerId, callId, call), (ran) =>
          call.tool === "read" && call.path === SandboxTools.REBASE_PATHS ? { ...ran, result: { ...ran.result, truncated: true } as typeof ran.result } : ran),
    })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: cut }))).exit)).toEqual(new Resync.ResyncRefused({ failure: "too_large" }))
    // An open text of a file the machine reads only in part can't be told saved: it stops the resync, listed.
    const readme = await opened(t, "README.md", "# Widgets\n", { saved: true })
    const partial = Machines.of({
      ...w.machines,
      tool: (branch, ownerId, callId, call) =>
        Effect.map(w.machines.tool(branch, ownerId, callId, call), (ran) =>
          call.tool === "read" && call.path === "README.md" ? { ...ran, result: { ...ran.result, truncated: true } as typeof ran.result } : ran),
    })
    expect((await resyncing(t, head, w.layer({ machines: partial }))).exit).toEqual(Exit.succeed({ state: "conflict", paths: ["README.md"] }))
    expect((await textOf(readme)).content).toBe("# Widgets\n")
    // Postgres down mid-resync: tried again.
    expect(failureOf((await resyncing(t, head, w.layer(), crypto.randomUUID(), DOWN)).exit)).toEqual(new Resync.ResyncUnavailable({}))
    expect(w.head()).toBe(w.base)
    // A machine whose workdir isn't a git checkout refuses.
    const empty = join(root, `empty-${++worlds}`)
    mkdirSync(empty)
    const bare = Box.boxAt({ workdir: empty, homes: join(empty, "..", `homes-empty-${worlds}`) })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: Box.machinesOn(bare.box) }))).exit)).toEqual(
      new Resync.ResyncRefused({ failure: "invalid" }),
    )
  })

  test("a Save between the plan and the apply: the apply changes nothing, and the next attempt takes the save along", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    w.sync()
    const t = await tracked(w, head)
    const guide = await opened(t, GUIDE, "one\ntwo\nthree\n", { saved: true })
    let saves = 0
    const saving = Machines.of({
      ...w.machines,
      tool: (branch, ownerId, callId, call) =>
        Effect.tap(w.machines.tool(branch, ownerId, callId, call), () =>
          Effect.sync(() => {
            // Right after the plan, the one run that names no tree to apply on.
            if (call.tool !== "run" || !call.command.endsWith("''") || saves > 0) return
            saves++
            write(w.workdir, { "saved.md": "meanwhile\n" })
          })),
    })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: saving }))).exit)).toEqual(new Resync.ResyncUnavailable({}))
    expect(w.head()).toBe(w.base)
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(w.read("saved.md")).toBe("meanwhile\n")
    expect(w.read(GUIDE)).toBe("one\ntwo main\nthree\n")
    // The first attempt recorded the guide's text before its apply was fenced off; the second brought it along.
    expect(await textOf(guide)).toEqual({ content: "one\ntwo main\nthree\n", saved: savedMarkOf("one\ntwo main\nthree\n") })
  })

  test("a step that stopped after the apply: run again, it brings the recorded texts along; one typed in since is listed", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n", "docs/other.md": "main's\n" })
    write(w.workdir, { "docs/other.md": "main's\n" })
    w.sync()
    const t = await tracked(w, head)
    const guide = await opened(t, GUIDE, "one\ntwo\nthree\n", { saved: true })
    // The working copy wrote main's other.md the way main did: its text follows it as it is.
    const other = await opened(t, "docs/other.md", "main's\n")
    // The machine stops answering once the working copy moved: the texts weren't brought along yet.
    const stopping = Machines.of({
      ...w.machines,
      tool: (branch, ownerId, callId, call) =>
        call.tool === "read" && call.path === GUIDE && git(w.workdir, "rev-parse", "HEAD") === head
          ? Effect.fail(new SandboxUnavailable({ reason: "exec" }))
          : w.machines.tool(branch, ownerId, callId, call),
    })
    expect(failureOf((await resyncing(t, head, w.layer({ machines: stopping }))).exit)).toEqual(new Resync.ResyncUnavailable({}))
    expect(w.head()).toBe(head)
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: null, syncing: { [GUIDE]: expect.any(String) } })
    expect((await textOf(guide)).content).toBe("one\ntwo\nthree\n")
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    expect(await textOf(guide)).toEqual({ content: "one\ntwo main\nthree\n", saved: savedMarkOf("one\ntwo main\nthree\n") })
    expect((await textOf(other)).content).toBe("main's\n")
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: head, state: "synced", syncing: null })

    // Again, with someone typing in the text after the working copy moved: their typing stays, and the file is listed.
    const w2 = world()
    write(w2.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w2, { "README.md": "# Widgets\n\nA line\n" })
    const head2 = updated(w2, { [GUIDE]: "one\ntwo main\nthree\n", "docs/also.md": "also main\n" })
    w2.sync()
    await sql(runtime, "TRUNCATE branch_publications, text_updates, branches CASCADE")
    const t2 = await tracked(w2, head2)
    const typedIn = await opened(t2, GUIDE, "one\ntwo\nthree\n", { saved: true })
    // Opened before the working copy had main's new file, so empty.
    const also = await opened(t2, "docs/also.md", "")
    const stopping2 = Machines.of({
      ...w2.machines,
      tool: (branch, ownerId, callId, call) =>
        call.tool === "read" && call.path === GUIDE && git(w2.workdir, "rev-parse", "HEAD") === head2
          ? Effect.fail(new SandboxUnavailable({ reason: "exec" }))
          : w2.machines.tool(branch, ownerId, callId, call),
    })
    expect(failureOf((await resyncing(t2, head2, w2.layer({ machines: stopping2 }))).exit)).toEqual(new Resync.ResyncUnavailable({}))
    await typed(t2, typedIn, "one\ntwo\nthree\ntyped\n")
    // Someone typed main's new file in exactly as main has it: nothing to bring along, and nothing listed.
    await typed(t2, also, "also main\n")
    expect((await resyncing(t2, head2, w2.layer())).exit).toEqual(Exit.succeed({ state: "conflict", paths: [GUIDE] }))
    expect((await textOf(typedIn)).content).toBe("one\ntwo\nthree\ntyped\n")
    expect((await textOf(also)).content).toBe("also main\n")
    expect(await publication(t2.branchId)).toMatchObject({ syncedSha: head2, state: "conflict", conflicts: [GUIDE], syncing: null })
  })
})

describe("branch/Resync and the resync after a Publish or an Update", { timeout: 60_000 }, () => {
  test("a person's Resync reads GitHub's head as them and settles done; a conflict settles refused with the files listed", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    const pushed = published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    w.sync()
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.refs.set(REF, head)
    const t = await tracked(w, pushed, github)
    const writeId = await admit(runtime, { actorId: t.maya.personId, sessionId: t.maya.sessionId, via: "person", payload: { op: "branch/resync", branchId: t.branchId } })
    const { services: built } = await services(runtime, github)
    const ran = await runFlow(Publish.Resync, { writeId }, Publish.registration(built, Layer.succeed(Machines, w.machines), Layer.succeed(Forge, w.forge)), {
      executionId: resyncExecutionId(writeId),
      maxConnections: 2,
    })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", prNumber: 1 }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
    expect(w.head()).toBe(head)
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: head, headSha: head, state: "synced" })
    // Settled already: a resend answers as it stands.
    expect(await runtime.runPromise(Publish.steps(built).resync({ writeId }).pipe(Effect.provide(w.layer()))))
      .toEqual({ status: "done", prNumber: 1 })

    // GitHub moves again on a file the working copy changes since.
    write(w.workdir, { [GUIDE]: "one\ntwo mine\nthree\n" })
    git(w.github, "checkout", "-q", REF)
    write(w.github, { [GUIDE]: "one\ntwo github\nthree\n" })
    git(w.github, "commit", "-q", "-am", "on github.com")
    const moved = git(w.github, "rev-parse", "HEAD")
    w.sync()
    github.refs.set(REF, moved)
    const again = await admit(runtime, { actorId: t.maya.personId, sessionId: t.maya.sessionId, via: "person", payload: { op: "branch/resync", branchId: t.branchId } })
    // The answer, with what it rests on: Code Storage at GitHub's new head, the working copy where it was.
    const answered = await runtime.runPromise(Publish.steps(built).resync({ writeId: again }).pipe(Effect.provide(w.layer())))
    expect({ answered, storage: git(w.storage, "rev-parse", "refs/heads/try-1"), head: w.head(), status: w.status() }).toEqual({
      answered: { status: "refused", prNumber: null },
      storage: moved,
      head,
      status: ["M docs/guide.md"],
    })
    expect(await writeRow(runtime, again)).toMatchObject({ status: "refused", failure: "conflict" })
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: head, state: "conflict", conflicts: [GUIDE] })
  })

  test("a Resync of a branch not published, one GitHub deleted, a missing write, and a machine down until it gives up", async () => {
    const w = world()
    const head = published(w, { "README.md": "# Widgets\n\nA line\n" })
    w.sync()
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const t = await tracked(w, head, github)
    const { services: built } = await services(runtime, github)
    const steps = Publish.steps(built)
    const asking = () => admit(runtime, { actorId: t.maya.personId, sessionId: t.maya.sessionId, via: "person", payload: { op: "branch/resync", branchId: t.branchId } })
    // GitHub's branch is gone.
    const deleted = await asking()
    expect(await runtime.runPromise(steps.resync({ writeId: deleted }).pipe(Effect.provide(w.layer())))).toEqual({ status: "refused", prNumber: null })
    expect(await writeRow(runtime, deleted)).toMatchObject({ status: "refused", failure: "not_found" })
    // The machine can't answer: tried again, then given up.
    github.refs.set(REF, head)
    const down = await asking()
    const machineDown = Machines.of({ ...w.machines, tool: () => Effect.fail(new SandboxUnavailable({ reason: "exec" })) })
    const exit = await runtime.runPromiseExit(steps.resync({ writeId: down }).pipe(Effect.provide(w.layer({ machines: machineDown }))))
    expect(failureOf(exit)).toBeInstanceOf(Publish.PublishUnavailable)
    expect(await runtime.runPromise(steps.giveUp({ writeId: down }))).toEqual({ status: "failed", prNumber: null })
    // The mirror hasn't GitHub's head: tried again after the mirror's wait.
    const behind = await asking()
    const lagging = Forge.of({ ...w.forge, move: () => Effect.fail(new CreateRefused({ code: "not_found" })) })
    const waited = await runtime.runPromiseExit(steps.resync({ writeId: behind }).pipe(Effect.provide(w.layer({ forge: lagging }))))
    expect(failureOf(waited)).toEqual(new Publish.PublishUnavailable({ retryAfterMillis: Resync.MIRROR_WAIT_MS }))
    expect(await runtime.runPromise(steps.giveUp({ writeId: behind }))).toEqual({ status: "failed", prNumber: null })
    // Postgres down: the Resync and the step after a Publish or an Update are tried again.
    const offline = Publish.steps({ ...built, database: DOWN })
    expect(failureOf(await runtime.runPromiseExit(offline.resync({ writeId: crypto.randomUUID() }).pipe(Effect.provide(w.layer())))))
      .toBeInstanceOf(Publish.PublishUnavailable)
    expect(failureOf(await runtime.runPromiseExit(offline.afterSettled({ writeId: crypto.randomUUID() }).pipe(Effect.provide(w.layer())))))
      .toBeInstanceOf(Publish.PublishUnavailable)
    // A forge that refuses the move refuses the Resync.
    const forbidden = await asking()
    const refusing = Forge.of({ ...w.forge, move: () => Effect.fail(new CreateRefused({ code: "forbidden" })) })
    expect(await runtime.runPromise(steps.resync({ writeId: forbidden }).pipe(Effect.provide(w.layer({ forge: refusing })))))
      .toEqual({ status: "refused", prNumber: null })
    expect(await writeRow(runtime, forbidden)).toMatchObject({ status: "refused", failure: "invalid" })
    // Not published (the publication is gone), and a write that isn't a Resync.
    await sql(runtime, `DELETE FROM branch_publications WHERE branch_id = '${t.branchId}'`)
    const unpublished = await asking()
    expect(await runtime.runPromise(steps.resync({ writeId: unpublished }).pipe(Effect.provide(w.layer())))).toEqual({ status: "refused", prNumber: null })
    expect(await writeRow(runtime, unpublished)).toMatchObject({ failure: "not_published" })
    expect(await runtime.runPromise(steps.resync({ writeId: crypto.randomUUID() }).pipe(Effect.provide(w.layer())))).toEqual({ status: "missing", prNumber: null })
  })

  test("after a Publish or an Update settled done, the working copy follows the head it recorded; anything else answers the write", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    w.sync()
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const t = await tracked(w, head, github)
    const { services: built } = await services(runtime, github)
    const steps = Publish.steps(built)
    const writeId = await admit(runtime, { actorId: t.maya.personId, sessionId: t.maya.sessionId, via: "person", payload: { op: "branch/update", branchId: t.branchId, method: "merge" } })
    const after = (id: string, layer = w.layer()) => runtime.runPromiseExit(steps.afterSettled({ writeId: id }).pipe(Effect.provide(layer)))
    // Still pending: its send hasn't settled it, so this waits.
    expect(failureOf(await after(writeId))).toBeInstanceOf(Publish.PublishUnavailable)
    await runtime.runPromise(Store.settleWrite(writeId, { status: "done", itemNumber: 1, githubId: null }))
    expect(await after(writeId)).toEqual(Exit.succeed({ status: "done", prNumber: 1 }))
    expect(w.head()).toBe(head)
    expect(await publication(t.branchId)).toMatchObject({ syncedSha: head, state: "synced" })
    // Followed already: nothing runs on the machine.
    const untouched = Machines.of({ ...w.machines, tool: () => Effect.die("the machine isn't asked") })
    expect(await after(writeId, w.layer({ machines: untouched }))).toEqual(Exit.succeed({ status: "done", prNumber: 1 }))
    // A refusal is logged and answers the write; an outage is tried again.
    await sql(runtime, `UPDATE branch_publications SET synced_sha = NULL WHERE branch_id = '${t.branchId}'`)
    const refusing = Forge.of({ ...w.forge, move: () => Effect.fail(new CreateRefused({ code: "forbidden" })) })
    expect(await after(writeId, w.layer({ forge: refusing }))).toEqual(Exit.succeed({ status: "done", prNumber: 1 }))
    const silent = Forge.of({ ...w.forge, move: () => Effect.fail(new CreateRefused({ code: "unavailable" })) })
    expect(failureOf(await after(writeId, w.layer({ forge: silent })))).toBeInstanceOf(Publish.PublishUnavailable)
    // A refused write, a Resync's own write, a branch gone, and a missing write answer as they stand.
    const refused = await admit(runtime, { actorId: t.maya.personId, sessionId: t.maya.sessionId, via: "person", payload: { op: "branch/publish", branchId: t.branchId, title: "t", body: "" } })
    await runtime.runPromise(Store.settleWrite(refused, { status: "refused", failure: "empty_change" }))
    expect(await after(refused, w.layer({ machines: untouched }))).toEqual(Exit.succeed({ status: "refused", prNumber: null }))
    expect(await after(crypto.randomUUID())).toEqual(Exit.succeed({ status: "missing", prNumber: null }))
    await sql(runtime, `DELETE FROM branch_publications WHERE branch_id = '${t.branchId}'`)
    expect(await after(writeId, w.layer({ machines: untouched }))).toEqual(Exit.succeed({ status: "done", prNumber: 1 }))
  })

  test("Publish again after a resync sends only what changed since GitHub's head, onto it", async () => {
    const w = world()
    write(w.workdir, { "README.md": "# Widgets\n\nA line\n" })
    published(w, { "README.md": "# Widgets\n\nA line\n" })
    const head = updated(w, { [GUIDE]: "one\ntwo main\nthree\n" })
    w.sync()
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    // GitHub's pull request 1, from `REF` at the merge, as Publish opened it and Update branch moved it.
    github.refs.set(REF, head)
    github.commits.set(head, {
      sha: head,
      message: "Merge main",
      parents: [],
      login: "maya",
      at: 0,
      files: new Map([["README.md", "# Widgets\n\nA line\n"], [GUIDE, "one\ntwo main\nthree\n"]]),
    })
    github.open("Add a line", "", "maya")
    github.pulls.set(1, { number: 1, head: REF, base: "main", baseSha: w.base, draft: false, merged: false, mergeSha: null, mergedBy: null, reviews: [] })
    const t = await tracked(w, head, github)
    expect((await resyncing(t, head, w.layer())).exit).toEqual(Exit.succeed({ state: "synced", sha: head }))
    // The file main changed, edited and saved after the Update.
    write(w.workdir, { [GUIDE]: "one\ntwo main\nthree\nfour\n" })
    const writeId = await admit(runtime, { actorId: t.maya.personId, sessionId: t.maya.sessionId, via: "person", payload: { op: "branch/publish", branchId: t.branchId, title: "Four", body: "" } })
    const { services: built } = await services(runtime, github)
    expect(await runtime.runPromise(Publish.steps(built).publish({ writeId }).pipe(Effect.provide(w.layer()))))
      .toEqual({ status: "done", prNumber: 1 })
    const commit = github.commits.get(github.refs.get(REF)!)!
    expect(commit.parents).toEqual([head])
    // One more commit onto the merge: the guide as saved; nothing else differs from GitHub's head.
    const parent = github.commits.get(head)!.files
    expect([...commit.files].filter(([path, content]) => parent.get(path) !== content)).toEqual([[GUIDE, "one\ntwo main\nthree\nfour\n"]])
  })
})
