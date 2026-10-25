import { Clock, Effect, Metric, Option } from "effect"
import { aboutOf, ensureBlob, ensureTree, locate, loaded, put, shown, until } from "./actions"
import { isRepository, repoId } from "./contract"
import { embedLoadMs } from "./metrics"
import { blobKey, readmeOf, treeKey } from "./paths"
import type { EmbedRow } from "./rows"
import { RepoStore } from "./store"

// A repository's view in a conversation (docs/features/views.md#a-repository-and-its-issues, decision 0004 §3): the
// `repo` template's row names the repository and where it opens; this tab loads what it shows, as the routed view
// loads a location (src/features/repo/actions.ts), into the same file lists and files, keyed by commit, so a view and
// the page it opens full screen share one load. What GitHub says of the repository comes first: a repository nobody
// cloned shows its root from it.

/** Where a repository's view opens: `owner/name`, and optionally a ref, a path and whether the path is a file. */
export interface EmbedTarget {
  readonly repo: string
  readonly ref?: string | undefined
  readonly kind?: "tree" | "blob" | undefined
  readonly path?: string | undefined
}

/** Changes the embed row `key`. */
const change = (key: string, fields: Partial<Omit<EmbedRow, "key">>) =>
  Effect.flatMap(RepoStore, ({ embeds }) => Effect.orDie(embeds.update(key, (row) => void Object.assign(row, fields))))

/**
 * What the view shows, once the tab can tell: the about read first, then, once the repositories' shape has answered, a
 * cloned repository's location, else GitHub's root. A ref or path the repository doesn't have is `missing`.
 */
const load = (row: EmbedRow, target: EmbedTarget) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    const about = yield* aboutOf(row.owner, row.name)
    // A clone ready to read, once the device can tell: its synced row, or RepoApi's refs naming its head first.
    const repository = yield* shown({ id: row.repoId, owner: row.owner, name: row.name })
    if (Option.isNone(repository)) {
      if (about.state === "missing") return yield* change(row.key, { state: "missing", message: about.message })
      if (about.state === "failed") return yield* change(row.key, { state: "failed", message: about.message })
      const root = row.path === "" && (target.ref === undefined || target.ref === about.about?.defaultBranch)
      return yield* change(row.key, { state: root ? "preview" : "not_cloned" })
    }
    const location = yield* locate(repository.value, {
      owner: row.owner,
      name: row.name,
      kind: row.kind,
      ref: target.ref ?? null,
      path: row.path,
      line: null,
      lineEnd: null,
    })
    if (location._tag === "Failed") return yield* change(row.key, { state: "failed", message: location.message })
    if (location._tag === "Missing") return yield* change(row.key, { state: "missing" })
    const { revision, sha, path } = location
    yield* ensureTree(repository.value, sha, false)
    const tree = yield* until(store.trees, treeKey(row.repoId, sha), loaded)
    const listed = tree.state === "ready" ? tree.paths : []
    // A path the repository lists as a file is one, unless the row says which.
    const kind = target.kind ?? (path !== "" && listed.includes(path) ? "blob" : "tree")
    const body = kind === "blob" ? path : readmeOf(listed, path)
    if (body !== undefined) yield* ensureBlob(repository.value, sha, body, false)
    yield* change(row.key, {
      state: "ready",
      kind,
      path,
      revision,
      sha,
      treeKey: treeKey(row.repoId, sha),
      bodyKey: body === undefined ? null : blobKey(row.repoId, sha, body),
      bodyPath: body ?? null,
    })
  })

/**
 * Loads repository view `viewId`, which opens `target`, unless this tab has it or is loading it: its row shows
 * `loading` at once, and the load runs in the store's scope, logged `repo.embed.load` with its outcome and duration.
 * A target that names no repository GitHub could have is `missing` at once.
 */
export const embed = (viewId: string, target: EmbedTarget) =>
  Effect.gen(function* () {
    const store = yield* RepoStore
    if (Option.isSome(yield* store.embeds.get(viewId))) return
    const [owner, name = ""] = target.repo.split("/") as [string, ...Array<string>]
    const row: EmbedRow = {
      key: viewId,
      repoId: repoId(owner, name),
      owner,
      name,
      kind: target.kind ?? "tree",
      path: target.path ?? "",
      state: isRepository(owner, name) ? "loading" : "missing",
      message: null,
      revision: null,
      sha: null,
      treeKey: null,
      bodyKey: null,
      bodyPath: null,
    }
    yield* put(store.embeds, viewId, row)
    if (row.state === "missing") return
    const startedAt = yield* Clock.currentTimeMillis
    yield* load(row, target).pipe(
      Effect.andThen(Effect.gen(function* () {
        const outcome = Option.getOrThrow(yield* store.embeds.get(viewId)).state
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(embedLoadMs, { outcome }), durationMs)
        yield* Effect.logWithLevel(outcome === "failed" ? "Warn" : "Info")("repo.embed.load").pipe(
          Effect.annotateLogs({ outcome, durationMs, feature: "repo" }),
        )
      })),
      Effect.forkIn(store.scope, { startImmediately: true }),
    )
  })
