import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import { knownLogin, load, open, type ProfileSearch, retry, warm } from "./actions"
import type { ProfileClient } from "./api"
import { ProfileStore } from "./store"

type Store = ProfileStore["Service"]

export interface ProfileQueries {
  readonly view: Store["viewState"]["tanstack"]
  readonly repositories: Store["repositories"]["tanstack"]
}

export interface ProfileActions {
  readonly warm: (owner: string) => Promise<void>
  readonly open: (owner: string, search: ProfileSearch) => void
  readonly retry: (owner: string) => void
  readonly knownLogin: (owner: string) => string | undefined
  readonly canonicalLogin: (owner: string) => Promise<string | undefined>
}

export class Profile extends Context.Service<
  Profile,
  { readonly queries: ProfileQueries; readonly actions: ProfileActions }
>()("@smthrs/mvp/profile/Profile") {
  static readonly layer = Layer.effect(
    Profile,
    Effect.gen(function* () {
      const store = yield* ProfileStore
      const context = yield* Effect.context<ProfileStore | ProfileClient>()
      const { runSync: run, runPromise: promise } = runners(context, "profile")
      return Profile.of({
        queries: {
          view: store.viewState.tanstack,
          repositories: store.repositories.tanstack,
        },
        actions: {
          warm: (owner) => promise(warm(owner)),
          open: (owner, search) => run(open(owner, search)),
          retry: (owner) => run(retry(owner)),
          knownLogin: (owner) => run(knownLogin(owner)),
          canonicalLogin: (owner) => promise(load(owner, false)),
        },
      })
    }),
  )
}

export type ProfileView = Profile["Service"]
