import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Context, Effect, FiberHandle, Layer, Option } from "effect"
import { Repository } from "../repo/schema"
import { RepoStore } from "../repo/store"
import { emptyProfileView, ProfileRow, ProfileViewRow } from "./schema"

// Tab-local state for the profile feature:
// - `entries`: fetched profiles cached in memory for this tab (keyed by lowercased login)
// - `view`: currently routed profile owner and URL-synced tab/search/sort/filter
// - `repositories`: live view of cloned repositories (from RepoStore when present) so cards badge repos on Smithers.

const viewQuery = (
  view: Collection.Collection<ProfileViewRow, string>,
  entries: Collection.Collection<ProfileRow, string>,
) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ entry: entries.tanstack }, ({ view, entry }) => Query.eq(view.key, entry.key))
      .findOne()
  )

const make = Effect.gen(function* () {
  const entries = yield* Collection.local<ProfileRow, string>({
    id: "profile-entries",
    schema: ProfileRow,
    getKey: (row) => row.key,
  })
  const view = yield* Collection.local<ProfileViewRow, string>({
    id: "profile-view",
    schema: ProfileViewRow,
    getKey: (row) => row.id,
    initialData: [emptyProfileView],
  })
  const repoStore = yield* Effect.serviceOption(RepoStore)
  const fallbackRepos = Option.isSome(repoStore)
    ? undefined
    : yield* Collection.local<Repository, string>({
      id: "profile-no-repositories",
      schema: Repository,
      getKey: (row) => row.id,
    })
  const repositories = yield* LiveQuery.make((q) =>
    q.from({ repo: Option.isSome(repoStore) ? repoStore.value.repositories.tanstack : fallbackRepos!.tanstack })
  )
  return {
    entries,
    view,
    viewState: yield* viewQuery(view, entries),
    repositories,
    inFlight: new Map<string, Promise<string | undefined>>(),
    loader: yield* FiberHandle.make<void, never>(),
    scope: yield* Effect.scope,
  }
})

export class ProfileStore extends Context.Service<ProfileStore, Effect.Success<typeof make>>()("@smthrs/mvp/profile/ProfileStore") {
  static readonly layer = Layer.effect(ProfileStore, make)
}
