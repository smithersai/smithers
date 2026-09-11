/*
 * The appearance mirror (§20.4).
 *
 * The live authority for theme and palette is the session in AppStore, and it
 * stays that way. But the store is asynchronous — OPFS/wa-sqlite on the web,
 * read after the module graph loads — so the first paint happened before the
 * choice was known and every load flashed the built-in light default at a user
 * who runs dark. localStorage is the one store a document can read
 * synchronously in `<head>`, so the two values are mirrored into it whenever
 * they are applied, and the inline bootstrap in index.html stamps the
 * attributes from the mirror before anything paints.
 *
 * A mirror, never a second source of truth: nothing reads it back into the
 * app, and a reset clears it with the rest of the prefixed keys, so a stale
 * value can only ever survive as far as the store's own first stamp.
 */
import { PERSISTED_KEY_PREFIX } from "../chain/SchemaVersion"

/** Where the bootstrap reads the last applied light/dark choice. */
export const THEME_MIRROR_KEY = `${PERSISTED_KEY_PREFIX}theme`

/** Where the bootstrap reads the last applied color theme. */
export const PALETTE_MIRROR_KEY = `${PERSISTED_KEY_PREFIX}palette`

/**
 * Mirror one applied appearance value for the next boot's first paint.
 *
 * Storage is allowed to refuse (private mode, a full quota, a browser with
 * storage disabled): appearance is a nicety and a refusal must never take the
 * app down with it, so the write is best-effort by design.
 */
export const rememberAppearance = (key: string, value: string): void => {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(key, value)
  } catch {
    // No mirror this time; the app still applies the value it just set.
  }
}
