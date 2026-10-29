import { Clock, Context, Data, Effect, Layer, Metric, Option } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import { aboutOf, fileAtTree, clone, copy, navigate, open, rawHref, refresh, retryAbout, retryClone, role, warm } from "./actions"
import type { RepoClient } from "./api"
import type { CopyKind } from "./contract"
import { type RouteParams, type Target, targetOf } from "./paths"
import { aliasChecks } from "./metrics"
import { reads } from "./queries"
import type { BlobRow, TreeRow } from "./rows"
import type { Repository } from "./schema"
import { RepoStore } from "./store"

// The repository feature as a frontend sees it: live queries to read and plain functions to act, with no Effect in
// sight. React renders the queries with `useLiveQuery`, and a route's loader calls `openRoute`.

type Store = RepoStore["Service"]

/**
 * What a frontend reads live: the routed view with its repository and clone request, its branches and tags, its file
 * list, file and README, and what GitHub says of the repository.
 */
export interface RepoQueries {
  readonly view: Store["viewState"]["tanstack"]
  readonly refs: Store["refsState"]["tanstack"]
  readonly tree: Store["treeState"]["tanstack"]
  readonly file: Store["fileState"]["tanstack"]
  readonly readme: Store["readmeState"]["tanstack"]
  /** What GitHub says of the view's repository, cloned or not. */
  readonly about: Store["aboutState"]["tanstack"]
  /** The repository's generated-files manifest at the view's commit, beside a file. */
  readonly manifest: Store["manifestState"]["tanstack"]
  /** Every repository's view in a conversation this tab loaded, with what it shows, by its view's id (`embed.key`). */
  readonly embeds: Store["embedsState"]["tanstack"]
  /** The person's role on each repository this tab opened, as ChatApi last answered (decision 0079). */
  readonly roles: Store["rolesState"]["tanstack"]
}

/** A Copy button's flow didn't put its text on the clipboard. */
export class NotCopied extends Data.TaggedError("NotCopied") {}

/** What the device has of any repository now, by id and commit; `undefined` until it has it. */
export interface RepoLookups {
  readonly repository: (id: string) => Repository | undefined
  readonly tree: (id: string, sha: string) => TreeRow | undefined
  readonly file: (id: string, sha: string, path: string) => BlobRow | undefined
  readonly readme: (id: string, sha: string, dir: string) => BlobRow | undefined
}

/** What a person does, as plain functions. Each returns at once, or with a promise of what the flow did. */
export interface RepoActions {
  readonly fileAtTree: (params: RouteParams) => Promise<boolean>
  /** GitHub's canonical owner/name after the public metadata read settles. */
  readonly canonicalName: (owner: string, name: string) => Promise<string | undefined>

  /** Clone pressed; `false` for an invalid name or insufficient/unavailable repository authority. */
  readonly clone: (owner: string, name: string) => boolean
  /** Try again on a failed or refused clone. */
  readonly retryClone: (owner: string, name: string) => boolean
  /** Try the public About read again after its durable retry window ends. */
  readonly retryAbout: (owner: string, name: string) => boolean
  /** Opens a location in the routed view. */
  readonly refresh: (target: Target) => void
  readonly open: (target: Target) => void
  /** What a route calls once the location is warm: opens it in the routed view. */
  readonly openRoute: (kind: "tree" | "blob", params: RouteParams, search: { readonly L?: unknown }) => void
  /**
   * What a route calls first, on a link's hover or focus and before every navigation: loads the location's files into
   * this tab without opening it. Resolves once they loaded or failed, or after a second (`pageWait`), so the page the
   * router then shows is complete or shows skeletons where its files will be.
   */
  readonly warmRoute: (kind: "tree" | "blob", params: RouteParams, search: { readonly L?: unknown }) => Promise<void>
  /** What the raw route's loader calls: RepoApi's raw route of its file at its commit, or `undefined`. */
  readonly rawRoute: (params: RouteParams) => Promise<string | undefined>
  /** A Copy button, through `repo/copy`: resolves once the text is on the clipboard, rejects `NotCopied` otherwise. */
  readonly copy: (what: CopyKind) => Promise<void>
  /** A ref chosen in the picker: `app/navigate` to `to`, its location at that ref. */
  readonly navigate: (to: string) => void
  /**
   * What every repository route calls once it opens: asks ChatApi who the person is on `owner/name`, their role there,
   * into `roles`. Returns at once.
   */
  readonly role: (owner: string, name: string) => void
}

export class Repo extends Context.Service<
  Repo,
  { readonly queries: RepoQueries; readonly lookups: RepoLookups; readonly actions: RepoActions }
>()("@smthrs/mvp/repo/Repo") {
  /**
   * Binds the store's queries and the actions for frontends. Each action runs its Effect with the services this layer
   * was built with (`runners`): `runSync`, or `runPromise` for one a caller awaits.
   */
  static readonly layer = Layer.effect(
    Repo,
    Effect.gen(function* () {
      const store = yield* RepoStore
      const context = yield* Effect.context<RepoStore | RepoClient | FlowDispatch>()
      const { runSync: run, runPromise: promise } = runners(context, "repo")
      const now = <A>(read: Effect.Effect<Option.Option<A>>) => Option.getOrUndefined(run(read))
      const device = reads(store)
      return Repo.of({
        queries: {
          view: store.viewState.tanstack,
          refs: store.refsState.tanstack,
          tree: store.treeState.tanstack,
          file: store.fileState.tanstack,
          readme: store.readmeState.tanstack,
          about: store.aboutState.tanstack,
          manifest: store.manifestState.tanstack,
          embeds: store.embedsState.tanstack,
          roles: store.rolesState.tanstack,
        },
        lookups: {
          repository: (id) => now(device.repository(id)),
          tree: (id, sha) => now(device.tree(id, sha)),
          file: (id, sha, path) => now(device.file(id, sha, path)),
          readme: (id, sha, dir) => now(device.readme(id, sha, dir)),
        },
        actions: {
          fileAtTree: (params) => promise(Effect.gen(function* () {
            const startedAt = yield* Clock.currentTimeMillis
            const checked = yield* fileAtTree(targetOf("tree", params, {})).pipe(Effect.timeoutOption(store.pageWait))
            const outcome = Option.isNone(checked) ? "timed_out" : checked.value ? "file" : "unconfirmed"
            const durationMs = (yield* Clock.currentTimeMillis) - startedAt
            yield* Metric.update(Metric.withAttributes(aliasChecks, { outcome }), 1)
            yield* Effect.logInfo("repo.alias.check").pipe(Effect.annotateLogs({ outcome, durationMs, feature: "repo" }))
            return Option.getOrElse(checked, () => false)
          }).pipe(Effect.withSpan("repo.alias.check"))),
          canonicalName: (owner, name) => promise(aboutOf(owner, name).pipe(
            Effect.timeoutOption(store.pageWait), Effect.map((row) => Option.isSome(row) ? row.value.about?.name : undefined),
          )),
          clone: (owner, name) => run(clone(owner, name)),
          retryClone: (owner, name) => run(retryClone(owner, name)),
          retryAbout: (owner, name) => run(retryAbout(owner, name)),
          refresh: (target) => run(refresh(target)),
          open: (target) => run(open(target)),
          openRoute: (kind, params, search) => run(open(targetOf(kind, params, search))),
          warmRoute: (kind, params, search) => promise(warm(targetOf(kind, params, search))),
          rawRoute: (params) => promise(rawHref(targetOf("blob", params, {}))),
          copy: (what) =>
            promise(Effect.flatMap(copy(what), (copied) => (copied ? Effect.void : Effect.fail(new NotCopied())))),
          navigate: (to) => run(Effect.asVoid(Effect.forkIn(navigate(to), store.scope))),
          role: (owner, name) => run(Effect.asVoid(Effect.forkIn(role(owner, name), store.scope))),
        },
      })
    }),
  )
}

/** The repository layer's value: what frontends get. */
export type RepoView = Repo["Service"]
