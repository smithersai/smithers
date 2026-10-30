import type { Host } from "@smthrs/plugin"
import { Effect } from "effect"

// The factory's one seam to the core's feed queries (decision 0126 §5, §7, docs/features/feeds.md): every read of a
// repository's feed documents goes through `Feeds`, so how a query learns its repository and a document's name changes
// here and nowhere else. The core asks them with `params`: `core/feeds` with `{ repo }` (the index), `core/feed` with
// `{ repo, name }` (one document, synced only while it is followed).

/** A feed document, as the core's feed queries have it. */
export interface FeedDocument {
  readonly id: string
  /** `owner/name`, lowercased. */
  readonly repo: string
  readonly name: string
  readonly visibility: "public" | "maintainers"
  readonly body: unknown
  readonly updatedAt: string
}

/**
 * An open decision of a repository's `for_will`, one row each, as the strip would answer it through `feed/answer`.
 * No core query serves these rows yet (docs/features/factory.md, "Not yet"): until one does, the host refuses `ASKS`
 * and the factory shows its decisions without answering them.
 */
export interface AskRow {
  readonly key: string
  readonly repo: string
  readonly item: string
  readonly options: ReadonlyArray<string>
}

/** The core's index of a repository's feed documents: every document whose name has no `/`. */
export const INDEX = "core/feeds"
/** One on-demand feed document, by name: `transcript/<lane>`, `diff/<commit>`, `report/...`. */
export const DOCUMENT = "core/feed"
/** A repository's open asks, one row per decision: what the action strip would answer. */
export const ASKS = "core/feed-asks"

/** What a query is asked for (`Host.QueryParams` of `@smthrs/plugin` 1.2). */
export type Params = Readonly<Record<string, string>>

/** `PluginHost`'s reads as the factory asks them: by name and `params`. */
export interface Reads {
  readonly query: <R>(name: string, params: Params) => Effect.Effect<Host.Live<R>, Host.PluginRefused>
  readonly select: (item: Host.ItemRef & { readonly params: Params }) => Effect.Effect<void, Host.PluginRefused>
}

/** `owner/name`, as feeds key a repository. */
export const repoOf = (repository: Host.Repository): string => `${repository.owner}/${repository.name}`.toLowerCase()

/** How the factory reads a repository's feeds. */
export interface Feeds {
  /** The repository's index documents, live. */
  readonly index: (repository: Host.Repository) => Effect.Effect<Host.Live<FeedDocument>, Host.PluginRefused>
  /** One document of the repository by name, live: none until the collector pushed it. */
  readonly document: (repository: Host.Repository, name: string) => Effect.Effect<Host.Live<FeedDocument>, Host.PluginRefused>
  /** The repository's open asks, live. */
  readonly asks: (repository: Host.Repository) => Effect.Effect<Host.Live<AskRow>, Host.PluginRefused>
  /** Tells the host the person looks at `ask`, so the strip under the view answers it. */
  readonly select: (ask: AskRow) => Effect.Effect<void, Host.PluginRefused>
}

/** The feeds over `host`'s reads. */
export const feedsOf = (host: Reads): Feeds => ({
  index: (repository) => host.query<FeedDocument>(INDEX, { repo: repoOf(repository) }),
  document: (repository, name) => host.query<FeedDocument>(DOCUMENT, { repo: repoOf(repository), name }),
  asks: (repository) => host.query<AskRow>(ASKS, { repo: repoOf(repository) }),
  select: (ask) => host.select({ query: ASKS, key: ask.key, params: { repo: ask.repo } }),
})
