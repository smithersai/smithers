import { LiveQuery } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { knownLogin, load, open, retry, TAB_FRESH_MS, warm } from "./actions.vibe"
import { ProfileClient, ProfileRefused } from "./api.vibe"
import { PROFILE_NOT_FOUND, PROFILE_UNAVAILABLE } from "./contract"
import type { Profile as ProfileData } from "./schema"
import { ProfileStore } from "./store.vibe"

// The profile actions against the real tab store, with ChatApi's client given as a service the test answers.

const sampleProfile = (login: string): ProfileData => ({
  kind: "User",
  login,
  name: null,
  avatarUrl: null,
  bio: null,
  company: null,
  location: null,
  website: null,
  twitter: null,
  pronouns: null,
  status: null,
  followers: null,
  following: null,
  publicRepos: 0,
  createdAt: null,
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

const tabWith = (get: (owner: string) => Effect.Effect<ProfileData, ProfileRefused>) => {
  const owners: Array<string> = []
  const runtime = ManagedRuntime.make(
    ProfileStore.layer.pipe(
      Layer.provideMerge(Layer.succeed(ProfileClient, ProfileClient.of({
        get: (owner) => Effect.suspend(() => {
          owners.push(owner)
          return get(owner)
        }),
      }))),
      Layer.provide(LiveQuery.incremental),
    ),
  )
  closing.push(() => runtime.dispose())
  const entry = (owner: string) =>
    runtime.runPromise(Effect.map(ProfileStore, (store) => store.entries.tanstack.get(owner.toLowerCase())))
  const seed = (row: Parameters<ProfileStore["Service"]["entries"]["insert"]>[0]) =>
    runtime.runPromise(Effect.flatMap(ProfileStore, (store) => store.entries.insert(row)))
  return { runtime, owners, entry, seed }
}

const search = { tab: "overview", search: "", sort: "updated", filter: "all" } as const

describe("features/profile actions", () => {
  test("an owner GitHub can't have is missing at once, without asking ChatApi", async () => {
    const tab = tabWith((owner) => Effect.succeed(sampleProfile(owner)))
    expect(await tab.runtime.runPromise(load("settings"))).toBeUndefined()
    expect(await tab.entry("settings")).toMatchObject({ state: "missing", profile: null, message: PROFILE_NOT_FOUND })
    expect(tab.owners).toEqual([])
  })

  test("a refusal with no status or code fails with the generic message", async () => {
    const tab = tabWith(() => Effect.fail(new ProfileRefused({})))
    expect(await tab.runtime.runPromise(load("ada"))).toBeUndefined()
    expect(await tab.entry("ada")).toMatchObject({ state: "failed", profile: null, message: PROFILE_UNAVAILABLE })
  })

  test("a refusal with another code and status fails with the generic message", async () => {
    const tab = tabWith(() => Effect.fail(new ProfileRefused({ status: 500, code: "upstream" })))
    expect(await tab.runtime.runPromise(load("ada"))).toBeUndefined()
    expect(await tab.entry("ada")).toMatchObject({ state: "failed", message: PROFILE_UNAVAILABLE })
  })

  test("a read already loading is not started again by load or open", async () => {
    const tab = tabWith((owner) => Effect.succeed(sampleProfile(owner)))
    await tab.seed({ key: "ada", state: "loading", profile: null, message: null, fetchedAt: Date.now() })
    expect(await tab.runtime.runPromise(load("Ada"))).toBeUndefined()
    await tab.runtime.runPromise(open("Ada", search))
    expect(tab.owners).toEqual([])
    expect(await tab.entry("ada")).toMatchObject({ state: "loading" })
  })

  test("a stale ready profile stays shown while it revalidates, and force reads a fresh one again", async () => {
    const answered = Deferred.makeUnsafe<void>()
    const tab = tabWith((owner) => Effect.as(Deferred.await(answered), sampleProfile(owner)))
    await tab.seed({ key: "ada", state: "ready", profile: sampleProfile("Ada"), message: null, fetchedAt: Date.now() - TAB_FRESH_MS - 1 })

    const pending = tab.runtime.runPromise(load("ada"))
    await vi.waitFor(() => expect(tab.owners).toEqual(["ada"]))
    expect(await tab.entry("ada")).toMatchObject({ state: "ready", profile: { login: "Ada" } })
    await tab.runtime.runPromise(Deferred.succeed(answered, undefined))
    expect(await pending).toBe("ada")

    // Fresh, a plain load answers from the tab; force asks ChatApi again.
    expect(await tab.runtime.runPromise(load("ADA"))).toBe("ada")
    expect(tab.owners).toEqual(["ada"])
    expect(await tab.runtime.runPromise(load("ada", true))).toBe("ada")
    expect(tab.owners).toEqual(["ada", "ada"])
  })

  test("retry reads again through the tab's loader, and knownLogin answers only ready rows", async () => {
    const tab = tabWith((owner) => Effect.succeed(sampleProfile(owner)))
    await tab.seed({ key: "ada", state: "failed", profile: null, message: PROFILE_UNAVAILABLE, fetchedAt: Date.now() })
    expect(await tab.runtime.runPromise(knownLogin("ada"))).toBeUndefined()
    expect(await tab.runtime.runPromise(knownLogin("nobody"))).toBeUndefined()
    await tab.runtime.runPromise(retry("ada"))
    await vi.waitFor(async () => expect(await tab.entry("ada")).toMatchObject({ state: "ready" }))
    expect(await tab.runtime.runPromise(knownLogin("ADA"))).toBe("ada")
  })

  test("warm lets navigation go on once WARM_WAIT passes without an answer", async () => {
    const tab = tabWith(() => Effect.never)
    const started = Date.now()
    await tab.runtime.runPromise(warm("ada"))
    expect(Date.now() - started).toBeGreaterThanOrEqual(850)
    expect(await tab.entry("ada")).toMatchObject({ state: "loading" })
  })
})
