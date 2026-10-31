// Why the page loaded again (docs/observability.md#page-reloads). Every place the app reloads its own page names a
// reason, which this tab's sessionStorage keeps across the reload; the next boot reads it, removes it and records it
// (`page.reload` in src/hostRecords.ts, logged as `page reloaded`). A record made just before a reload rarely reaches
// ChatApi before the page unloads; the next boot's always can. Reasons only: never a URL, a path or an error's message.
// Nothing here imports a library.

/** Why the app reloaded its page, or `browser` for a reload the app didn't ask for (the person's own, or unattributed). */
export const RELOAD_REASONS = [
  /** A new release activated and the page was hidden (src/pwa.ts `applyRelease`). */
  "pwa_update",
  /** A new release activated and this page needed a module only the old release had (`vite:preloadError`). */
  "stale_module",
  /** A session answer named someone other than the device's owner, so every page checks the owner again. */
  "identity_reopen",
  /** A tab of an older build leads one of the device store's collections (src/device/olderLeader.ts). */
  "older_leader",
  /** Sign-out's wipe (src/wipe.ts). */
  "wipe",
  /** Another tab, of a build that names no reason, asked every page to load again (src/wipe.ts `reopen`). */
  "wipe_channel_reopen",
  /** Reload on the app's error page (src/screens/root/AppErrorBoundary.tsx). */
  "error_retry",
  /** Reload on the pill when this tab's engine stopped (src/features/chat/components/ConnectionPill.tsx). */
  "engine_stopped",
  /** A page restored from the back/forward cache (src/features/chat/connectivity.ts). */
  "bfcache",
  /** The browser reloaded the page and the app didn't ask for it. */
  "browser",
] as const

export type ReloadReason = (typeof RELOAD_REASONS)[number]

/** The reasons the app itself reloads for: every one but `browser`. */
export type AppReloadReason = Exclude<ReloadReason, "browser">

/** The sessionStorage key the reason waits in across the reload. */
export const RELOAD_REASON_KEY = "smithers-reload-reason"

/** How long a stored reason stays this tab's next boot's: a reload the browser never made leaves one behind. */
export const RELOAD_REASON_WITHIN_MS = 60_000

/** This tab's sessionStorage, read when used: a browser that blocks storage throws on reaching it. */
export type ReasonStorage = () => Pick<Storage, "getItem" | "setItem" | "removeItem">

/** What reloading with a reason takes: the storage, the clock, the console line, and the reload itself. */
export interface ReloadHost {
  readonly storage: ReasonStorage
  readonly now: () => number
  readonly log: (reason: AppReloadReason) => void
  readonly reload: () => void
}

/** Reloads the page for `reason`: stores it for the next boot, logs it, then reloads. Blocked storage only loses it. */
export const reloadFor = (host: ReloadHost) => (reason: AppReloadReason): void => {
  try {
    host.storage().setItem(RELOAD_REASON_KEY, JSON.stringify({ reason, at: host.now() }))
  } catch {
    // expected: blocked storage loses the reason; the next boot records `browser` instead
  }
  host.log(reason)
  host.reload()
}

const isReason = (value: unknown): value is AppReloadReason =>
  typeof value === "string" && value !== "browser" && (RELOAD_REASONS as ReadonlyArray<string>).includes(value)

const stored = (storage: ReasonStorage, now: number): AppReloadReason | undefined => {
  try {
    const raw = storage().getItem(RELOAD_REASON_KEY)
    if (raw === null) return undefined
    storage().removeItem(RELOAD_REASON_KEY)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const { reason, at } = parsed as { reason?: unknown; at?: unknown }
    if (!isReason(reason) || typeof at !== "number" || now - at > RELOAD_REASON_WITHIN_MS || at > now) return undefined
    return reason
  } catch {
    // expected: blocked storage, or a value this build can't read, names no reason
    return undefined
  }
}

/**
 * Why this boot is a reload, once: only when the browser says it reloaded (`navigation` is the navigation timing
 * entry's type), the reason the app stored before it reloaded, else `browser`. The stored reason is removed either way:
 * one a reload never followed (the page was leaving when it asked) never names a later navigation, Back or a reopened
 * tab, which are not reloads.
 */
export const reloadedBecause = (storage: ReasonStorage, navigation: string | undefined, now: number): ReloadReason | undefined => {
  const reason = stored(storage, now)
  return navigation === "reload" ? reason ?? "browser" : undefined
}
