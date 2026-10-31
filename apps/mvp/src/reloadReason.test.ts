import { describe, expect, test } from "vitest"
import { RELOAD_REASON_KEY, RELOAD_REASON_WITHIN_MS, reloadedBecause, reloadFor } from "./reloadReason"

// Why a page loaded again (src/reloadReason.ts): the reason a reload stores in the tab's sessionStorage, read once by the
// next boot. The storage is a Map behind Storage's three methods; a blocked one throws as a browser's does.

const tab = () => {
  const entries = new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  }
  return { entries, storage: () => storage }
}

const blocked = () => {
  throw new DOMException("blocked", "SecurityError")
}

describe("reloading for a reason", () => {
  test("stores the reason and when, logs it, then reloads; the next boot reads it once", () => {
    const { entries, storage } = tab()
    const events: Array<string> = []
    reloadFor({
      storage,
      now: () => 1_000,
      log: (reason) => events.push(`log ${reason}`),
      reload: () => events.push("reload"),
    })("pwa_update")
    expect(events).toEqual(["log pwa_update", "reload"])
    expect(JSON.parse(entries.get(RELOAD_REASON_KEY)!)).toEqual({ reason: "pwa_update", at: 1_000 })
    expect(reloadedBecause(storage, "reload", 1_500)).toBe("pwa_update")
    // Read once: the boot after this one knows nothing of it.
    expect(entries.has(RELOAD_REASON_KEY)).toBe(false)
    expect(reloadedBecause(storage, "navigate", 1_600)).toBeUndefined()
  })

  test("blocked storage still logs and reloads; the next boot calls it the browser's", () => {
    const events: Array<string> = []
    reloadFor({ storage: blocked, now: () => 0, log: (reason) => events.push(reason), reload: () => events.push("reload") })(
      "wipe",
    )
    expect(events).toEqual(["wipe", "reload"])
    expect(reloadedBecause(blocked, "reload", 0)).toBe("browser")
    expect(reloadedBecause(blocked, "navigate", 0)).toBeUndefined()
  })
})

describe("why this boot is a reload", () => {
  test("a reload the app didn't ask for is the browser's; any other load is no reload", () => {
    const { storage } = tab()
    expect(reloadedBecause(storage, "reload", 0)).toBe("browser")
    expect(reloadedBecause(storage, "navigate", 0)).toBeUndefined()
    expect(reloadedBecause(storage, "back_forward", 0)).toBeUndefined()
    expect(reloadedBecause(storage, undefined, 0)).toBeUndefined()
  })

  test("a stored reason counts only within its window, never from the future, and only if it is one", () => {
    const at = 10_000
    const cases: ReadonlyArray<readonly [string, number]> = [
      [JSON.stringify({ reason: "bfcache", at }), at + RELOAD_REASON_WITHIN_MS],
      [JSON.stringify({ reason: "bfcache", at }), at + RELOAD_REASON_WITHIN_MS + 1],
      [JSON.stringify({ reason: "bfcache", at }), at - 1],
      [JSON.stringify({ reason: "browser", at }), at],
      [JSON.stringify({ reason: "nonsense", at }), at],
      [JSON.stringify({ reason: "bfcache", at: "then" }), at],
      [JSON.stringify("bfcache"), at],
      [JSON.stringify(null), at],
      ["{not json", at],
    ]
    const read = cases.map(([value, now]) => {
      const { entries, storage } = tab()
      entries.set(RELOAD_REASON_KEY, value)
      const reason = reloadedBecause(storage, "reload", now)
      // Whatever it held, it is gone.
      expect(entries.has(RELOAD_REASON_KEY)).toBe(false)
      return reason
    })
    expect(read).toEqual(["bfcache", "browser", "browser", "browser", "browser", "browser", "browser", "browser", "browser"])
  })

  test("a fresh reason a reload never followed never names a load that isn't one: Back, a reopened tab, a link", () => {
    for (const navigation of ["back_forward", "navigate", "prerender", undefined]) {
      const { entries, storage } = tab()
      entries.set(RELOAD_REASON_KEY, JSON.stringify({ reason: "pwa_update", at: 0 }))
      expect(reloadedBecause(storage, navigation, 1)).toBeUndefined()
      // And it is gone, so the next reload doesn't claim it either.
      expect(entries.has(RELOAD_REASON_KEY)).toBe(false)
    }
  })

  test("a stale reason left by a reload that never happened falls back to what the browser says", () => {
    const { entries, storage } = tab()
    entries.set(RELOAD_REASON_KEY, JSON.stringify({ reason: "older_leader", at: 0 }))
    expect(reloadedBecause(storage, "reload", RELOAD_REASON_WITHIN_MS * 2)).toBe("browser")
  })
})
