import type { Collection } from "@smthrs/effect-tanstack-db"
import { Clock, Effect, FiberHandle, Metric, Option, Stream } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { nearestManifest } from "../generated/detect"
import { RepoClient, type RepoRefused } from "./api"
import type { ReadFailure } from "./flows"
import {
  BUSY,
  COULDNT_LOAD,
  GITHUB_DOWN,
  GITHUB_LIMIT,
  type CopyKind,
  isRepository,
  NOT_FOUND,
  NOT_SYNCED,
  rawRoute,
  READING_PAUSED,
  repoId,
  textOf,
} from "./contract"
import { aboutLoadMs, blobLoadMs, cloneClicks, headLoadMs, locateMs, opens, refsLoadMs, roleAnswers, treeLoadMs } from "./metrics"
import { blobKey, copyPayloadOf, readmeOf, refsKey, resolveRef, type Target, treeKey } from "./paths"
import type { AboutRow, BlobRow, CloneRow, HeadRow, RefsRow, TreeRow, ViewRow } from "./rows"
import { VIEW } from "./rows"
import type { Repository } from "./schema"
import { RepoStore } from "./store"

// What a person does in the repository view, and what the tab does for them. Each action returns once the tab's rows
// say so; a request it starts runs in the store's scope and settles the rows when RepoApi answers.
//
// A clone is the flow `repo/clone`, whose step asks RepoApi, not a write through chat's outbox (decision 0002 §3): it
// needs the network and sign-in anyway, and RepoApi takes it idempotently, so a request that didn't get through is
// safe to send again with Try again. The outbox would add a stored write and a lock for nothing a refresh can't redo.
// Copying and choosing another ref are flows too (`repo/copy`, `app/navigate`), which the agent runs as well.

/** Inserts `row`, or replaces the row with its key. */
export const put = <A extends object>(collection: Collection.Collection<A, string>, key: string, row: A) =>
  Effect.gen(function* () {
    if (Option.isNone(yield* collection.get(key))) yield* collection.insert(row)
    else yield* collection.update(key, (draft) => void Object.assign(draft, row))
  }).pipe(Effect.orDie)

/** Changes the view row. */
const changeView = (fields: Partial<Omit<ViewRow, "id">>) =>
  Effect.flatMap(RepoStore, ({ view }) => Effect.orDie(view.update(VIEW, (row) => void Object.assign(row, fields))))

/** Starts the repositories' shape, if nothing read it yet; a device that can't reach Electric keeps what it has. */
export const startSync = Effect.flatMap(
  RepoStore,
  (store) => Effect.forkIn(store.firstSync, store.scope, { startImmediately: true }),
)

// --- Cloning ---

/** How the header shows a clone `repo/clone` didn't start: sign in, imports paused at the cap, or couldn't clone. */
const refusedStatus = (reason: string | undefined): CloneRow["status"] =>
  reason === "sign_in" ? "sign_in" : reason === "limit" ? "limit" : "failed"

/**
 * Dispatches `repo/clone`, door `button`, then waits for Electric to deliver what RepoApi did. The flow's step records
 * the request; a row Electric doesn't deliver within `confirmWithin` is logged `repo.clone.unconfirmed`.
 */
const send = (row: CloneRow) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const dispatched = yield* Effect.result(
      (yield* FlowDispatch).dispatch("repo/clone", { repo: `${row.owner}/${row.name}` }, { door: "button" }),
    )
    if (dispatched._tag === "Failure" || dispatched.success._tag === "Failed") {
      const error = dispatched._tag === "Success" && dispatched.success._tag === "Failed"
        ? dispatched.success.error
        : undefined
      const reason = error?._tag === "@smthrs/mvp/repo/RepoCloneRefused" ? error.reason : undefined
      return yield* put<CloneRow>(store.clones, row.id, { ...row, status: refusedStatus(reason) })
    }
    const accepted = dispatched.success.value
    yield* startSync
    // The repository's row reaches every tab of the device, the one that stores the shape's rows and the ones that
    // watch, so the wait is on the row, there already or once it shows. Rows show only once the device has restored
    // them, so the wait counts from then, and the restore waits as long at most.
    // expected: restore failures are logged by Collection, and a slow restore is bounded by confirmWithin
    yield* Effect.ignore(Effect.timeout(store.repositories.restored, store.confirmWithin))
    const delivered = store.repositories.awaitRow((repository) => repository.id === accepted.id, store.confirmWithin)
    if ((yield* Effect.result(delivered))._tag === "Failure") {
      yield* put<CloneRow>(store.clones, row.id, { ...row, status: "failed" })
      return yield* Effect.logWarning("repo.clone.unconfirmed").pipe(
        Effect.annotateLogs({ outcome: "unconfirmed", reason: "not_delivered" }),
      )
    }
    yield* Effect.orDie(store.clones.delete(row.id))
  }).pipe(Effect.annotateLogs({ feature: "repo" }))

/**
 * Clone pressed (`kind` `clone`), or Try again (`retry`): shows `cloning` at once and runs `repo/clone`, once at a time
 * per repository. RepoApi starts a new attempt for a failed or refused clone and nothing for one running or done. Answers
 * whether it asked: `false` for a name that isn't a GitHub repository.
 */
export const clone = (owner: string, name: string, kind: "clone" | "retry" = "clone") =>
  Effect.gen(function* () {
    if (!isRepository(owner, name)) return false
    const store = yield* RepoStore
    const id = repoId(owner, name)
    yield* Metric.update(Metric.withAttributes(cloneClicks, { kind }), 1)
    const pending = yield* store.clones.get(id)
    if (Option.isSome(pending) && pending.value.status === "requesting") return true
    const row: CloneRow = { id, owner, name, status: "requesting" }
    yield* put<CloneRow>(store.clones, id, row)
    yield* Effect.forkIn(send(row), store.scope, { startImmediately: true })
    return true
  })

/** Try again on a failed or refused clone. */
export const retryClone = (owner: string, name: string) => clone(owner, name, "retry")

// --- Reading ---

/** What a failed read shows: gone, the read budget spent, Code Storage busy, or couldn't load. */
const readFailure = (refused: RepoRefused): string =>
  refused.code === "not_synced" ? NOT_SYNCED :
  refused.status === 404
    ? NOT_FOUND
    : refused.status === 503 && refused.code === "capacity"
    ? READING_PAUSED
    : refused.status === 503
    ? BUSY
    : COULDNT_LOAD

/** A repository as its reads name it. */
interface Named {
  readonly id: string
  readonly owner: string
  readonly name: string
}

/**
 * Loads `owner/name`'s file list at `sha` unless this tab has it or is loading it. A failed one loads again when
 * `again`: a navigation's warm asks again, and the page it then opens shows what that answered.
 */
export const ensureTree = (repository: Named, sha: string, again: boolean) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const key = treeKey(repository.id, sha)
    const found = yield* store.trees.get(key)
    if (Option.isSome(found) && (found.value.state !== "failed" || !again)) return
    yield* put<TreeRow>(store.trees, key, { key, state: "loading", paths: [], truncated: false, message: null })
    const load = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* Effect.result(
        (yield* RepoClient).tree(repository.owner, repository.name, sha),
      )
      const row: TreeRow = result._tag === "Success"
        ? { key, state: "ready", paths: result.success.paths, truncated: result.success.truncated, message: null }
        : { key, state: "failed", paths: [], truncated: false, message: readFailure(result.failure) }
      yield* put(store.trees, key, row)
      yield* observeLoad("repo.tree.load", treeLoadMs, row.state, startedAt, result)
    })
    yield* Effect.forkIn(load, store.scope, { startImmediately: true })
  })

/** Loads `owner/name`'s branches and tags as of its sync unless this tab has them or is loading them. */
const ensureRefs = (repository: Named, key: string) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const found = yield* store.refs.get(key)
    if (Option.isSome(found) && found.value.state !== "failed") return
    yield* put<RefsRow>(store.refs, key, { key, state: "loading", branches: [], tags: [], truncated: false, message: null })
    const load = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* Effect.result((yield* RepoClient).refs(repository.owner, repository.name))
      const row: RefsRow = result._tag === "Success"
        ? {
          key,
          state: "ready",
          branches: result.success.branches,
          tags: result.success.tags,
          truncated: result.success.truncated,
          message: null,
        }
        : { key, state: "failed", branches: [], tags: [], truncated: false, message: readFailure(result.failure) }
      yield* put(store.refs, key, row)
      yield* observeLoad("repo.refs.load", refsLoadMs, row.state, startedAt, result)
    })
    yield* Effect.forkIn(load, store.scope, { startImmediately: true })
  })

/** What a failed About read shows: the read budget spent, GitHub's limit, GitHub not answering, or couldn't load. */
const aboutFailure = (failure: ReadFailure | undefined): string =>
  failure?._tag === "@smthrs/mvp/repo/RepoReadsPaused"
    ? READING_PAUSED
    : failure?._tag === "@smthrs/mvp/repo/RepoReadUnavailable" && failure.reason === "rate_limited"
    ? GITHUB_LIMIT
    : failure?._tag === "@smthrs/mvp/repo/RepoReadUnavailable" && failure.reason === "github_unavailable"
    ? GITHUB_DOWN
    : COULDNT_LOAD

/**
 * Loads what GitHub says of `owner/name` unless this tab has it or is loading it. A failed read waits for Try again, so
 * navigation through the repository cannot spend another rate-limit window. It needs no
 * clone, so the page shows it from the first visit: the about panel, and before a clone the top folder and README.
 * The read is the flow `repo/about`, door `view`, on this device's engine: a refusal that may pass (GitHub or RepoApi
 * busy, unreachable or rate limited) is tried again by the step's retry policy while the panel shows it loading, so a
 * moment's 503 keeps the page loading; a terminal refusal leaves Try again in the page.
 */
const ensureAbout = (owner: string, name: string, id: string, door: "view" | "button" = "view") =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const found = yield* store.abouts.get(id)
    if (Option.isSome(found) && (found.value.state !== "failed" || door !== "button")) return
    yield* put<AboutRow>(store.abouts, id, { key: id, state: "loading", about: null, message: null })
    const load = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const dispatched = yield* Effect.result(
        (yield* FlowDispatch).dispatch("repo/about", { repo: `${owner}/${name}` }, { door }),
      )
      const failure = dispatched._tag === "Success" && dispatched.success._tag === "Failed"
        ? dispatched.success.error
        : undefined
      const row: AboutRow = dispatched._tag === "Success" && dispatched.success._tag === "Done"
        ? { key: id, state: "ready", about: dispatched.success.value, message: null }
        : failure?._tag === "@smthrs/mvp/repo/RepoNotFound"
        ? { key: id, state: "missing", about: null, message: NOT_FOUND }
        : { key: id, state: "failed", about: null, message: aboutFailure(failure) }
      yield* put(store.abouts, id, row)
      const durationMs = (yield* Clock.currentTimeMillis) - startedAt
      yield* Metric.update(Metric.withAttributes(aboutLoadMs, { outcome: row.state }), durationMs)
      yield* Effect.logWithLevel(row.state === "failed" ? "Warn" : "Info")("repo.about.load").pipe(
        Effect.annotateLogs({
          outcome: row.state,
          durationMs,
          feature: "repo",
          ...(dispatched._tag === "Failure"
            ? { reason: dispatched.failure.reason }
            : dispatched.success._tag === "Failed"
            ? { error: dispatched.success.error._tag }
            : {}),
        }),
      )
    })
    yield* Effect.forkIn(load, store.scope, { startImmediately: true })
  })

/** A person retries a terminal About refusal through the same durable read flow. */
export const retryAbout = (owner: string, name: string) =>
  isRepository(owner, name)
    ? Effect.as(ensureAbout(owner, name, repoId(owner, name), "button"), true)
    : Effect.succeed(false)

/**
 * Asks ChatApi who the person is on `owner/name` (decision 0079): their role there and whether it is the deployment's
 * own repository, kept in this tab's `roles` row for the repository, which the header's links and each page's buttons
 * read. A refused answer keeps the row this tab had: nothing role-gated shows on a repository ChatApi never answered.
 * One log line and span `repo.role` and one count, with the outcome, the role and whether it is the deployment's own.
 */
export const role = (owner: string, name: string) =>
  Effect.gen(function* () {
    if (!isRepository(owner, name)) return
    const store = yield* RepoStore
    const id = repoId(owner, name)
    const startedAt = yield* Clock.currentTimeMillis
    const result = yield* Effect.result((yield* RepoClient).role(owner, name))
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    if (result._tag === "Failure") {
      yield* Metric.update(Metric.withAttributes(roleAnswers, { outcome: "refused", role: "unknown" }), 1)
      return yield* Effect.logWarning("repo.role").pipe(
        Effect.annotateLogs({ outcome: "refused", status: result.failure.status ?? 0, durationMs }),
      )
    }
    const { role: held, own, readable } = result.success
    yield* put(store.roles, id, { id, role: held, own, readable })
    yield* Metric.update(Metric.withAttributes(roleAnswers, { outcome: "answered", role: held ?? "none" }), 1)
    yield* Effect.logInfo("repo.role").pipe(
      Effect.annotateLogs({ outcome: "answered", role: held ?? "none", own, durationMs }),
    )
  }).pipe(Effect.withSpan("repo.role"))

/**
 * What GitHub says of `owner/name`, once this tab has loaded it: loads it unless this tab has it or is loading it, then
 * waits for the load to end, `ready`, `missing` or `failed`. The home reads a repository's own home from it before a
 * clone.
 */
export const aboutOf = (owner: string, name: string) =>
  Effect.gen(function* () {
    const id = repoId(owner, name)
    yield* ensureAbout(owner, name, id)
    return yield* until((yield* RepoStore).abouts, id, loaded)
  })

/** Loads a file at `sha` unless this tab has it or is loading it; a failed one loads again when `again`, as a tree. */
export const ensureBlob = (repository: Named, sha: string, path: string, again: boolean) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const key = blobKey(repository.id, sha, path)
    const found = yield* store.blobs.get(key)
    if (Option.isSome(found) && (found.value.state !== "failed" || !again)) return
    yield* put<BlobRow>(store.blobs, key, { key, state: "loading", contents: null, size: null, message: null })
    const load = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* Effect.result(
        (yield* RepoClient).blob(repository.owner, repository.name, sha, path),
      )
      const row = blobRow(key, result)
      yield* put(store.blobs, key, row)
      yield* observeLoad("repo.blob.load", blobLoadMs, row.state, startedAt, result)
    })
    yield* Effect.forkIn(load, store.scope, { startImmediately: true })
  })

/** A loaded file's row: its text, binary or too large with its size, or why it failed. */
const blobRow = (
  key: string,
  result: { readonly _tag: "Success"; readonly success: { readonly bytes: Uint8Array } } | {
    readonly _tag: "Failure"
    readonly failure: RepoRefused
  },
): BlobRow => {
  if (result._tag === "Failure") {
    const { status, size } = result.failure
    return status === 413 && size !== undefined
      ? { key, state: "too-large", contents: null, size, message: null }
      : { key, state: "failed", contents: null, size: null, message: readFailure(result.failure) }
  }
  const bytes = result.success.bytes
  const contents = textOf(bytes)
  return contents === undefined
    ? { key, state: "binary", contents: null, size: bytes.byteLength, message: null }
    : { key, state: "text", contents, size: bytes.byteLength, message: null }
}

/** One load's records: its duration by outcome, and a log line with the outcome and RepoApi's status. */
const observeLoad = (
  message: string,
  histogram: typeof treeLoadMs,
  outcome: string,
  startedAt: number,
  result: { readonly _tag: "Success" } | { readonly _tag: "Failure"; readonly failure: RepoRefused },
) =>
  Effect.gen(function* () {
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    yield* Metric.update(Metric.withAttributes(histogram, { outcome }), durationMs)
    const status = result._tag === "Failure" ? result.failure.status : undefined
    yield* Effect.logWithLevel(outcome === "failed" ? "Warn" : "Info")(message).pipe(
      Effect.annotateLogs({ outcome, durationMs, ...(status === undefined ? {} : { status }), feature: "repo" }),
    )
  })

/** Whether a repository's row is ready, with its head: Settle writes a ready row's head with its status. */
export const isReady = (row: Option.Option<Repository>): row is Option.Some<Repository & { readonly headSha: string }> =>
  Option.isSome(row) && row.value.status === "ready" && row.value.headSha !== null

/** Waits until the repository is ready on this device, with its head: Electric delivers it, or the device has it. */
export const ready = (id: string) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    yield* startSync
    const now = yield* store.repositories.get(id)
    if (isReady(now)) return now.value
    // With the rows the device has as the first batch, so a row that arrived since the read above isn't missed.
    const next = yield* store.repositories.changes({ initial: true }).pipe(
      Stream.mapEffect(() => store.repositories.get(id)),
      Stream.filter(isReady),
      Stream.runHead,
    )
    // The changes stream never ends, so a head is always found.
    return Option.getOrThrow(next).value
  })

/** Waits until the row at `key` matches `done`: one that has, or once one does. */
export const until = <A extends object>(collection: Collection.Collection<A, string>, key: string, done: (row: A) => boolean) =>
  Effect.gen(function* () {
    const matches = (row: Option.Option<A>): row is Option.Some<A> => Option.isSome(row) && done(row.value)
    const now = yield* collection.get(key)
    if (matches(now)) return now.value
    const next = yield* collection.changes({ initial: true }).pipe(
      Stream.mapEffect(() => collection.get(key)),
      Stream.filter(matches),
      Stream.runHead,
    )
    // The changes stream never ends, so a head is always found.
    return Option.getOrThrow(next).value
  })

/** Whether a load has ended: loaded or failed. */
export const loaded = (row: { readonly state: string }) => row.state !== "loading"

// --- Resolving ---
//
// A file reads at a commit, so a page needs the repository's ready head before anything else. The device's synced row
// has it once Electric delivers it; RepoApi's refs read the same row in Postgres directly. A page waits for whichever
// answers first, so a visitor's first page (no rows on the device yet) or a slow shape never holds a file back, and a
// device that has the ready row asks RepoApi nothing (docs/features/repo.md#a-pages-head).

/**
 * A repository whose clone is ready, as reading its files needs it: its default branch and head commit, where its
 * branches and tags are kept in `refs`, and where the head came from: the device's synced `row`, or RepoApi's `refs`.
 */
interface Readable extends Named {
  readonly defaultBranch: string | null
  readonly headSha: string
  readonly refsKey: string
  readonly source: "row" | "refs"
}

/** A ready synced row, as its files read. */
const fromRow = (row: Repository & { readonly headSha: string }): Readable => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  defaultBranch: row.defaultBranch,
  headSha: row.headSha,
  refsKey: refsKey(row.id, row.headSha, row.refsChangedAt),
  source: "row",
})

/**
 * Asks RepoApi's refs for `owner/name`'s ready head unless this tab has it or is asking: the default branch and head
 * commit Postgres has, and every branch and tag, which `refs` keeps under that head. A 404 is `absent`, no ready clone.
 * An absent or failed answer is asked again when `again`: a navigation's warm asks again, as for a file list.
 */
const ensureHead = (repository: Named, again: boolean) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const { id } = repository
    const found = yield* store.heads.get(id)
    if (Option.isSome(found) && (found.value.state === "loading" || found.value.state === "ready" || !again)) return
    yield* put<HeadRow>(store.heads, id, { key: id, state: "loading", defaultBranch: null, headSha: null })
    const load = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* Effect.result((yield* RepoClient).refs(repository.owner, repository.name))
      if (result._tag === "Success") {
        const { head, branches, tags, truncated } = result.success
        const key = refsKey(id, head)
        yield* put<RefsRow>(store.refs, key, { key, state: "ready", branches, tags, truncated, message: null })
      }
      const row: HeadRow = result._tag === "Success"
        ? { key: id, state: "ready", defaultBranch: result.success.defaultBranch, headSha: result.success.head }
        : { key: id, state: result.failure.status === 404 ? "absent" : "failed", defaultBranch: null, headSha: null }
      yield* put(store.heads, id, row)
      yield* observeLoad("repo.head.load", headLoadMs, row.state, startedAt, result)
    })
    yield* Effect.forkIn(load, store.scope, { startImmediately: true })
  })

/** The head RepoApi's refs named for `repository`, once they answered: ready, absent or failed. */
const answeredHead = (repository: Named) => Effect.flatMap(RepoStore, (store) => until(store.heads, repository.id, loaded))

/** A ready head RepoApi's refs named, as its files read. */
const fromHead = (repository: Named, head: HeadRow): Readable => ({
  id: repository.id,
  owner: repository.owner,
  name: repository.name,
  defaultBranch: head.defaultBranch,
  // A ready head always names its commit (`ensureHead`).
  headSha: head.headSha!,
  refsKey: refsKey(repository.id, head.headSha!),
  source: "refs",
})

/**
 * Waits until the repository's clone is ready, for the routed view's load: its synced row when the device has it
 * ready, else whichever is first of Electric delivering a ready row and RepoApi's refs naming its ready head. A refs
 * answer that says it isn't ready, or can't answer, leaves the wait on the row, which a clone that settles delivers.
 */
const readable = (repository: Named) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const now = yield* store.repositories.get(repository.id)
    if (isReady(now)) return fromRow(now.value)
    yield* ensureHead(repository, false)
    const fromRefs = Effect.flatMap(
      answeredHead(repository),
      (head) => (head.state === "ready" ? Effect.succeed(fromHead(repository, head)) : Effect.never),
    )
    return yield* Effect.raceFirst(Effect.map(ready(repository.id), fromRow), fromRefs)
  })

/**
 * The repository a page will show files of, for a navigation's warm, once the device can tell: its row, ready or why
 * not (not cloned, cloning, failed or refused: none); without a row, whichever is first of the repositories' shape's
 * first sync and RepoApi's refs, ready or absent. A refs read that couldn't answer leaves it to the shape.
 */
export const shown = (repository: Named) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const now = yield* store.repositories.get(repository.id)
    if (Option.isSome(now)) return isReady(now) ? Option.some(fromRow(now.value)) : Option.none()
    yield* ensureHead(repository, true)
    const synced = store.firstSync.pipe(
      Effect.andThen(store.repositories.get(repository.id)),
      Effect.map((row) => (isReady(row) ? Option.some(fromRow(row.value)) : Option.none())),
    )
    const fromRefs = Effect.flatMap(answeredHead(repository), (head) =>
      head.state === "ready"
        ? Effect.succeedSome(fromHead(repository, head))
        : head.state === "absent"
        ? Effect.succeedNone
        : Effect.never)
    return yield* Effect.raceFirst(synced, fromRefs)
  })

/** Where a location is in a ready repository: its ref resolved to a commit, the ref's load failed, or no such ref. */
type Location =
  | { readonly _tag: "Located"; readonly revision: string; readonly sha: string; readonly path: string }
  | { readonly _tag: "Failed"; readonly message: string | null }
  | { readonly _tag: "Missing" }

/**
 * Resolves `target`'s ref in a ready repository: loads its branches and tags, and waits for them only when the ref is
 * neither the default branch nor a SHA. A head RepoApi's refs named comes with its branches and tags already.
 */
export const locate = (repository: Readable, target: Target) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const refs = repository.refsKey
    yield* ensureRefs(repository, refs)
    let resolved = resolveRef(repository, target.ref, target.path)
    if (resolved === undefined) {
      const known = yield* until(store.refs, refs, loaded)
      if (known.state === "failed") return { _tag: "Failed", message: known.message } satisfies Location
      resolved = resolveRef(repository, target.ref, target.path, known)
    }
    if (resolved === undefined) return { _tag: "Missing" } satisfies Location
    return { _tag: "Located", ...resolved } satisfies Location
  })

/**
 * Once the file list at `sha` has loaded, loads the generated-files manifest nearest `path` (a file, or a directory's
 * page for the branch's editor over it), when a folder on the way has one (docs/features/repo.md#generated-files).
 */
const ensureManifest = (repository: Named, sha: string, path: string, kind: "tree" | "blob") =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const tree = yield* until(store.trees, treeKey(repository.id, sha), loaded)
    if (tree.state !== "ready") return
    const manifest = nearestManifest(new Set(tree.paths), kind === "tree" ? `${path === "" ? "" : `${path}/`}-` : path)
    if (manifest === undefined) return
    yield* changeView({ manifestPath: manifest, manifestKey: blobKey(repository.id, sha, manifest) })
    yield* ensureBlob(repository, sha, manifest, false)
  })

/**
 * The routed view's load: once the repository is ready (`readable`), resolves the URL's ref (`locate`), then the file
 * list and the file, or for a directory its README. It reads what `warm` loaded and asks for what isn't loading yet; a
 * failed load stays failed, since the navigation's warm just asked again. Knowing where the location is, a log line
 * `repo.locate` and `locateMs` say how long that took and where the head came from.
 */
const load = (target: Target, id: string) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const startedAt = yield* Clock.currentTimeMillis
    const repository = yield* readable({ id, owner: target.owner, name: target.name })
    yield* changeView({ refsKey: repository.refsKey })
    const location = yield* locate(repository, target)
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const outcome = location._tag === "Located" ? "located" : location._tag === "Missing" ? "missing" : "failed"
    yield* Metric.update(Metric.withAttributes(locateMs, { source: repository.source, outcome }), durationMs)
    yield* Effect.logInfo("repo.locate").pipe(Effect.annotateLogs({ source: repository.source, outcome, durationMs }))
    if (location._tag === "Failed") return yield* changeView({ failure: location.message })
    if (location._tag === "Missing") return yield* changeView({ missing: true })
    const { revision, sha, path } = location
    const fileKey = target.kind === "blob" ? blobKey(id, sha, path) : null
    yield* changeView({ revision, sha, path, defaultBranch: repository.defaultBranch, treeKey: treeKey(id, sha), fileKey })
    yield* ensureTree(repository, sha, false)
    if (target.kind === "blob") {
      yield* ensureBlob(repository, sha, path, false)
      return yield* ensureManifest(repository, sha, path, "blob")
    }
    const tree = yield* until(store.trees, treeKey(id, sha), loaded)
    // The branch's editor opens a file over a directory's page, and marks it generated from the manifest too.
    yield* ensureManifest(repository, sha, path, "tree")
    const readme = tree.state === "ready" ? readmeOf(tree.paths, path) : undefined
    if (readme === undefined) return
    yield* changeView({ readmeKey: blobKey(id, sha, readme), readmePath: readme })
    yield* ensureBlob(repository, sha, readme, false)
  })

/**
 * The repository a page will show files of, once the device can tell: its row when it is ready, or none when the page
 * says why not instead (not cloned, cloning, failed or refused). A repository the device has no row for waits for the
 * repositories' shape to finish its first sync, or to fail.
 */
export const shownRepository = (id: string) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const now = yield* store.repositories.get(id)
    if (Option.isSome(now)) return isReady(now) ? Option.some(now.value) : Option.none()
    yield* store.firstSync
    const synced = yield* store.repositories.get(id)
    return isReady(synced) ? Option.some(synced.value) : Option.none()
  })

/**
 * Loads what `target`'s page shows into this tab without opening it: what GitHub says of the repository, then, once the
 * device's row or RepoApi's refs say its clone is ready (`shown`), the file list and the file, or the directory's
 * README; for a repository nobody cloned, only what GitHub says. Ends once they
 * have loaded or failed, or after the store's `pageWait`, whichever is first; a request still on its way finishes in
 * the store's scope. A failed load loads again. A link's hover or focus runs it (the router's intent preload), and so does every navigation before it
 * opens the page, which then shows it complete.
 */
export const warm = (target: Target) =>
  Effect.gen(function* () {
    if (!isRepository(target.owner, target.name)) return
    const store = yield* RepoStore
    const id = repoId(target.owner, target.name)
    yield* ensureAbout(target.owner, target.name, id)
    const repository = yield* shown({ id, owner: target.owner, name: target.name })
    // Not cloned: the page shows what GitHub says of it, so that is what to wait for.
    if (Option.isNone(repository)) return yield* Effect.asVoid(until(store.abouts, id, loaded))
    const location = yield* locate(repository.value, target)
    if (location._tag !== "Located") return
    const { sha, path } = location
    yield* ensureTree(repository.value, sha, true)
    if (target.kind === "blob") {
      yield* ensureBlob(repository.value, sha, path, true)
      return yield* Effect.asVoid(until(store.blobs, blobKey(id, sha, path), loaded))
    }
    const tree = yield* until(store.trees, treeKey(id, sha), loaded)
    const readme = tree.state === "ready" ? readmeOf(tree.paths, path) : undefined
    if (readme === undefined) return
    yield* ensureBlob(repository.value, sha, readme, true)
    yield* until(store.blobs, blobKey(id, sha, readme), loaded)
  }).pipe(
    (warming) => Effect.flatMap(RepoStore, (store) => Effect.timeoutOption(warming, store.pageWait)),
    Effect.asVoid,
    Effect.withSpan("repo.warm", { attributes: { "smithers.repo.kind": target.kind } }),
    Effect.annotateLogs({ feature: "repo" }),
  )

/**
 * Opens `target` in the routed view: the view row says where at once, and the tab loads what it needs in its scope,
 * once the repository is ready (`readable`). Opening another location interrupts a load still waiting; a request already sent
 * finishes and keeps what it read.
 */
export const open = (target: Target, again = false) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const valid = isRepository(target.owner, target.name)
    const id = valid ? repoId(target.owner, target.name) : null
    yield* changeView({
      owner: target.owner,
      name: target.name,
      repoId: id,
      kind: target.kind,
      ref: target.ref,
      splat: target.path,
      line: target.line,
      lineEnd: target.lineEnd,
      missing: !valid,
      failure: null,
      revision: null,
      sha: null,
      path: target.path,
      defaultBranch: null,
      refsKey: null,
      treeKey: null,
      fileKey: null,
      readmeKey: null,
      readmePath: null,
      manifestPath: null,
      manifestKey: null,
    })
    yield* Metric.update(Metric.withAttributes(opens, { kind: target.kind }), 1)
    yield* Effect.logInfo("repo.open").pipe(Effect.annotateLogs({ kind: target.kind }))
    if (id === null) return yield* FiberHandle.clear(store.loader)
    // What GitHub says loads at once, cloned or not: the page is never empty while the clone isn't ready.
    yield* ensureAbout(target.owner, target.name, id)
    yield* FiberHandle.run(store.loader, again ? warm(target).pipe(Effect.andThen(load(target, id))) : load(target, id), { startImmediately: true })
  }).pipe(
    Effect.withSpan("repo.open", { attributes: { "smithers.repo.kind": target.kind } }),
    Effect.annotateLogs({ feature: "repo" }),
  )

/**
 * A Copy button: dispatches `repo/copy` for what the view shows (`copyPayloadOf`), door `button`, which puts it on
 * this tab's clipboard. Answers whether it is there: `false` when the view has nothing of that kind yet, or the flow
 * didn't copy. `repo/copy`'s step records every copy.
 */
export const copy = (what: CopyKind) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const payload = copyPayloadOf(Option.getOrThrow(yield* store.view.get(VIEW)), what)
    if (payload === undefined) return false
    const dispatched = yield* Effect.result((yield* FlowDispatch).dispatch("repo/copy", payload, { door: "button" }))
    return dispatched._tag === "Success" && dispatched.success._tag === "Done" && dispatched.success.value.copied
  })

/**
 * Another branch, tag or commit chosen in the picker: `app/navigate` to `to`, the same location at that ref, door
 * `button`, which moves this tab. Dispatch records it.
 */
export const navigate = (to: string) =>
  Effect.flatMap(FlowDispatch, (dispatch) => Effect.ignore(dispatch.dispatch("app/navigate", { to }, { door: "button" })))

/**
 * `/$owner/$repo/raw/$ref/$`, GitHub's raw path (`target` is its file): opens the file in the routed view, and once the repository is ready
 * on this device (Electric gets `confirmWithin` to deliver it) and the ref resolves, answers RepoApi's raw route at
 * its commit, which the route's loader loads in place of the app. `undefined` when there is nothing to load: the view
 * shows why.
 */
export const rawHref = (target: Target) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    yield* open(target)
    const opened = Option.getOrThrow(yield* store.view.get(VIEW))
    if (opened.repoId === null || target.path === "") return undefined
    // Electric gets `confirmWithin` to deliver the row; the page then shows what the device has.
    yield* Effect.timeoutOption(store.firstSync, store.confirmWithin)
    const row = yield* store.repositories.get(opened.repoId)
    if (Option.isNone(row) || row.value.status !== "ready") return undefined
    const view = yield* until(store.view, VIEW, (view) => view.missing || view.failure !== null || view.sha !== null)
    return view.sha === null ? undefined : rawRoute(view.owner, view.name, view.sha, view.path)
  })

/** Re-read a location after its mirror refresh, discarding only the mutable refs listing. */
export const refresh = (target: Target) => Effect.gen(function* () {
  const store = yield* RepoStore
  const view = Option.getOrThrow(yield* store.view.get(VIEW))
  if (view.refsKey !== null) yield* Effect.orDie(store.refs.delete(view.refsKey))
  yield* open(target, true)
})
