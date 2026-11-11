import * as Effect from "effect/Effect"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Runs `effect` with `process.cwd()` in a fresh, empty temporary directory.
 *
 * An unbound `NodeJj.layer` or `NodeJj.layerSpawner` runs jj in the caller's
 * working directory and fences on the nearest `.jj` above it. The suite starts
 * in this package, so without this a case takes the lock fences of the
 * checkout and its shared store, waits behind any real operation holding them,
 * and writes into the checkout's `.jj`. The directory has no `.jj`, so such a
 * case takes only in-process permits, as it does on a git-only checkout.
 */
export const inTemporaryDirectory = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.cwd()
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "flows-jj-cwd-")))
      process.chdir(directory)
      return { previous, directory }
    }),
    () => effect,
    ({ previous, directory }) =>
      Effect.sync(() => {
        process.chdir(previous)
        rmSync(directory, { recursive: true, force: true })
      })
  )
