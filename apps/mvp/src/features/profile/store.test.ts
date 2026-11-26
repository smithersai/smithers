import { LiveQuery, Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, ManagedRuntime } from "effect"
import { expect, test } from "vitest"
import { repoAuthority } from "../../test/repoAuthority"
import { RepoStore } from "../repo/store"
import { ProfileStore } from "./store.vibe"

// With the repository feature on the tab, profile cards badge its synced repositories rather than an empty stand-in.
test("the profile's repositories read the tab's RepoStore when it is present", async () => {
  const runtime = ManagedRuntime.make(
    ProfileStore.layer.pipe(
      Layer.provideMerge(repoAuthority),
      Layer.provide(Persistence.memory),
      Layer.provide(LiveQuery.incremental),
    ),
  )
  try {
    const [store, repos] = await runtime.runPromise(Effect.all([ProfileStore, RepoStore]))
    expect(await runtime.runPromise(store.repositories.toArray)).toEqual(await runtime.runPromise(repos.repositories.toArray))
  } finally {
    await runtime.dispose()
  }
})
