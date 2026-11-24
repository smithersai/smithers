/**
 * Atomic replacement of queue documents on disk.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"

/**
 * Replace a complete document in the same directory as its destination.
 *
 * @category persistence
 * @since 0.1.0
 */
export const writeJson = (fs: FileSystem.FileSystem, path: string, value: unknown) =>
  Effect.gen(function*() {
    const temporary = path + "." + crypto.randomUUID() + ".next"
    yield* Effect.andThen(fs.writeFileString(temporary, JSON.stringify(value) + "\n"), fs.rename(temporary, path)).pipe(
      Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore))
    )
  })
