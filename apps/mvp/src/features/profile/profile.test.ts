import { LiveQuery } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ProfileClient, ProfileRefused } from "./api.vibe"
import { Profile } from "./profile.vibe"
import type { Profile as ProfileData } from "./schema"
import { ProfileStore } from "./store.vibe"

const sampleProfile = (login = "roninjin10"): ProfileData => ({
  kind: "User",
  login,
  name: "Will Cory",
  avatarUrl: "https://avatars.githubusercontent.com/u/35039927",
  bio: "Building Smithers.",
  company: "@smithersai",
  location: "San Francisco",
  website: "https://smithers.sh",
  twitter: "FUCORY",
  pronouns: null,
  status: null,
  followers: 1200,
  following: 30,
  publicRepos: 42,
  createdAt: "2018-01-01T00:00:00Z",
  organizations: [],
  pinned: [],
  repositories: [],
  readme: null,
  contributions: null,
})

const closing: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close()
})

const openProfileLayer = (get: (owner: string) => Effect.Effect<ProfileData, ProfileRefused>) => {
  const runtime = ManagedRuntime.make(
    Profile.layer.pipe(
      Layer.provideMerge(ProfileStore.layer),
      Layer.provide(Layer.succeed(ProfileClient, ProfileClient.of({ get }))),
      Layer.provide(LiveQuery.incremental),
    ),
  )
  closing.push(() => runtime.dispose())
  return runtime
}

describe("features/profile state machine", () => {
  test("warms, opens, caches and recovers from failures on retry", async () => {
    let calls = 0
    let shouldFail = true
    const runtime = openProfileLayer((owner) =>
      Effect.suspend(() => {
        calls += 1
        if (owner === "nobody-here") return Effect.fail(new ProfileRefused({ status: 404, code: "not_found" }))
        if (shouldFail) return Effect.fail(new ProfileRefused({ status: 503, code: "rate_limited" }))
        return Effect.succeed(sampleProfile("roninjin10"))
      })
    )
    const profile = await runtime.runPromise(Effect.service(Profile))
    profile.queries.view.startSyncImmediate()

    // Failed load surfaces rate-limit refusal, then retry succeeds.
    profile.actions.open("roninjin10", { tab: "overview", search: "", sort: "updated", filter: "all" })
    await vi.waitFor(() => {
      expect(profile.queries.view.toArray[0]?.entry?.state).toBe("failed")
      expect(profile.queries.view.toArray[0]?.entry?.message).toBe("GitHub limit reached")
    })
    expect(calls).toBe(1)

    shouldFail = false
    profile.actions.retry("roninjin10")
    await vi.waitFor(() => {
      expect(profile.queries.view.toArray[0]?.entry?.state).toBe("ready")
      expect(profile.queries.view.toArray[0]?.entry?.profile?.login).toBe("roninjin10")
    })
    expect(calls).toBe(2)
    expect(profile.actions.knownLogin("RONINJIN10")).toBe("roninjin10")
    expect(await profile.actions.canonicalLogin("RONINJIN10")).toBe("roninjin10")

    // Re-opening within TAB_FRESH_MS reuses cached data without another API call.
    profile.actions.open("roninjin10", { tab: "repositories", search: "vibe", sort: "stars", filter: "sources" })
    expect(profile.queries.view.toArray[0]?.view.tab).toBe("repositories")
    expect(calls).toBe(2)

    // Missing owner transitions cleanly to missing state.
    await profile.actions.warm("nobody-here")
    profile.actions.open("nobody-here", { tab: "overview", search: "", sort: "updated", filter: "all" })
    await vi.waitFor(() => {
      expect(profile.queries.view.toArray[0]?.entry?.state).toBe("missing")
    })
  })
})
