/*
 * A clean slate for the live checks, and a HONEST one.
 *
 * The app persists its store to OPFS through wa-sqlite, with localStorage only
 * as the fallback. Wave 12 tried to clear OPFS from inside the page:
 *
 *   for await (const name of root.keys()) await root.removeEntry(name).catch(() => {})
 *
 * Every one of those `removeEntry` calls throws `NoModificationAllowedError` —
 * the VFS holds sync access handles on `smithers-mvp.sqlite`(+`-wal`,
 * `-journal`) for as long as the page is alive — and the `.catch(() => {})`
 * swallowed all of it. The check then printed "cleared the persisted
 * transcript (localStorage + OPFS)" and had cleared nothing, so an earlier
 * run's cards and an earlier run's PROSE were still being read as this run's.
 * A truth assertion against a stale transcript is not a truth assertion, and a
 * note that says it cleared when it did not is the same defect the wave is
 * about, one layer down.
 *
 * The fix is to stop asking the page to delete files it is holding open: leave
 * the origin first (which tears down the page and its workers, releasing the
 * handles), clear at the BROWSER level over CDP, and only then come back.
 * Cookies are deliberately not in the list — the signed-in checks must keep
 * their session.
 */
import type { BrowserContext, Page } from "playwright"

/** The storage buckets a stale transcript can hide in. Cookies stay. */
const STORAGE_TYPES = "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers"

/**
 * Clear this origin's persisted app state and return to `url`. Resolves to the
 * OPFS entries still present afterwards — empty means the slate is genuinely
 * clean, and a caller that claims a fresh transcript should check it rather
 * than assert it.
 */
export const resetPersistedStore = async (
  context: BrowserContext,
  page: Page,
  url: string
): Promise<ReadonlyArray<string>> => {
  const origin = new URL(url).origin
  await page.goto("about:blank", { waitUntil: "domcontentloaded" })
  const client = await context.newCDPSession(page)
  await client.send("Storage.clearDataForOrigin", { origin, storageTypes: STORAGE_TYPES })
  await client.detach().catch(() => {})
  await page.goto(url, { waitUntil: "domcontentloaded" })
  // Read the truth back: whatever survived is named, never assumed away.
  return await page.evaluate(async () => {
    const storage = navigator.storage as { getDirectory?: () => Promise<unknown> } | undefined
    const root = (await storage?.getDirectory?.().catch(() => undefined)) as
      | { keys?: () => AsyncIterable<string> }
      | undefined
    if (root?.keys === undefined) return []
    const names: Array<string> = []
    for await (const name of root.keys()) names.push(name)
    return names
  })
}
