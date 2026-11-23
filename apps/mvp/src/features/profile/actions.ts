import { Clock, Duration, Effect, FiberHandle, Metric } from "effect"
import { put } from "../repo/actions"
import { ProfileClient, type ProfileRefused } from "./api"
import {
  isProfileOwner,
  PROFILE_NOT_FOUND,
  PROFILE_RATE_LIMITED,
  PROFILE_UNAVAILABLE,
  profileKey,
  type ProfileFilter,
  type ProfileSort,
  type ProfileTab,
} from "./contract"
import { profileLoadMs, profileOpens } from "./metrics"
import type { ProfileRow } from "./schema"
import { ProfileStore } from "./store"

/** How long a tab reuses a ready profile before re-fetching on a new navigation. */
export const TAB_FRESH_MS = 60_000

/** Maximum time `warm` waits before letting navigation continue with the skeleton/loading state. */
export const WARM_WAIT = Duration.millis(900)

export interface ProfileSearch {
  readonly tab: ProfileTab
  readonly search: string
  readonly sort: ProfileSort
  readonly filter: ProfileFilter
}

const refusalMessage = (error: ProfileRefused): string => {
  if (error.status === 404 || error.code === "not_found") return PROFILE_NOT_FOUND
  if (error.code === "rate_limited") return PROFILE_RATE_LIMITED
  return PROFILE_UNAVAILABLE
}

const upsert = (entries: ProfileStore["Service"]["entries"], row: ProfileRow) =>
  put<ProfileRow>(entries, row.key, row).pipe(Effect.ignore)

/** Fetches `owner` into `ProfileStore.entries` if not fresh (or when `force` is true). */
export const load = (owner: string, force = false): Effect.Effect<string | undefined, never, ProfileStore | ProfileClient> =>
  Effect.gen(function* () {
    const store = yield* ProfileStore
    const client = yield* ProfileClient
    const key = profileKey(owner)
    const now = yield* Clock.currentTimeMillis
    const existing = store.entries.tanstack.get(key)

    if (!isProfileOwner(owner)) {
      yield* upsert(store.entries, {
        key,
        state: "missing",
        profile: null,
        message: PROFILE_NOT_FOUND,
        fetchedAt: now,
      })
      return undefined
    }

    if (!force && existing !== undefined) {
      if (existing.state === "ready" && now - existing.fetchedAt < TAB_FRESH_MS) return existing.profile?.login
      if (existing.state === "loading") return undefined
    }

    // Preserve a previously loaded profile while revalidating; only set loading when no ready data exists.
    if (existing === undefined || existing.state !== "ready") {
      yield* upsert(store.entries, {
        key,
        state: "loading",
        profile: null,
        message: null,
        fetchedAt: now,
      })
    }

    const startedAt = yield* Clock.currentTimeMillis
    const result = yield* Effect.result(client.get(owner))
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const settledAt = yield* Clock.currentTimeMillis

    if (result._tag === "Success") {
      yield* upsert(store.entries, {
        key,
        state: "ready",
        profile: result.success,
        message: null,
        fetchedAt: settledAt,
      })
      yield* Metric.update(Metric.withAttributes(profileLoadMs, { outcome: "ready" }), durationMs)
      yield* Effect.logInfo("profile.load").pipe(Effect.annotateLogs({ outcome: "ready", durationMs }))
      return result.success.login
    }

    const error = result.failure
    const missing = error.status === 404 || error.code === "not_found"
    const outcome = missing ? "missing" : error.code === "rate_limited" ? "rate_limited" : "failed"
    yield* upsert(store.entries, {
      key,
      state: missing ? "missing" : "failed",
      profile: null,
      message: refusalMessage(error),
      fetchedAt: settledAt,
    })
    yield* Metric.update(Metric.withAttributes(profileLoadMs, { outcome }), durationMs)
    yield* Effect.logWarning("profile.load").pipe(
      Effect.annotateLogs({
        outcome,
        durationMs,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.code === undefined ? {} : { errorCode: error.code }),
      }),
    )
    return undefined
  }).pipe(Effect.withSpan("profile.load"))

/** Warms `owner`'s profile on link hover/focus or before route open, bounded by `WARM_WAIT`. */
export const warm = (owner: string): Effect.Effect<void, never, ProfileStore | ProfileClient> =>
  load(owner, false).pipe(
    Effect.asVoid,
    Effect.timeoutOrElse({ duration: WARM_WAIT, orElse: () => Effect.void }),
  )

/** Opens `owner`'s profile route with its URL-synced view state and loads if not fresh. */
export const open = (owner: string, search: ProfileSearch): Effect.Effect<void, never, ProfileStore | ProfileClient> =>
  Effect.gen(function* () {
    const store = yield* ProfileStore
    const key = profileKey(owner)
    const previous = store.view.tanstack.get("view")
    const changedOwner = previous?.key !== key
    yield* store.view.update("view", (row) => {
      row.key = key
      row.owner = owner
      row.tab = search.tab
      row.search = search.search
      row.sort = search.sort
      row.filter = search.filter
    }).pipe(Effect.ignore)

    if (changedOwner) {
      yield* Metric.update(Metric.withAttributes(profileOpens, { tab: search.tab }), 1)
      yield* Effect.logInfo("profile.open").pipe(Effect.annotateLogs({ tab: search.tab }))
    }

    const existing = store.entries.tanstack.get(key)
    const now = yield* Clock.currentTimeMillis
    const fresh = existing?.state === "ready" && now - existing.fetchedAt < TAB_FRESH_MS
    if (!fresh && existing?.state !== "loading") {
      yield* FiberHandle.run(store.loader, load(owner, false).pipe(Effect.asVoid))
    }
  }).pipe(Effect.withSpan("profile.open"))

/** Retries a failed profile read for `owner`. */
export const retry = (owner: string): Effect.Effect<void, never, ProfileStore | ProfileClient> =>
  Effect.gen(function* () {
    const store = yield* ProfileStore
    yield* FiberHandle.run(store.loader, load(owner, true).pipe(Effect.asVoid))
  })

/** Returns GitHub's canonical casing for `owner` if already loaded in this tab. */
export const knownLogin = (owner: string): Effect.Effect<string | undefined, never, ProfileStore> =>
  Effect.gen(function* () {
    const store = yield* ProfileStore
    const row = store.entries.tanstack.get(profileKey(owner))
    return row?.state === "ready" ? row.profile?.login : undefined
  })
