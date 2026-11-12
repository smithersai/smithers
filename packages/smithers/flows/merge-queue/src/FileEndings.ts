/**
 * The record of endings as a file: one JSON line per change that ended,
 * appended by the queue and never rewritten.
 *
 * The file is what an author, a dashboard or an audit reads to learn how a
 * change ended and why. It needs only Effect's `FileSystem` and `Clock`. A
 * change has at most one line: an ending for a change the file already holds
 * is not written again, so a round that runs twice records once.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Ending } from "./Schema.ts"
import { Endings, Unavailable } from "./Services.ts"

/**
 * One line of the record: an ending and when it was recorded, in milliseconds
 * since the epoch.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Line = Schema.Struct({ ...Ending.fields, at: Schema.Int })

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line))

const unavailable = (detail: string) => new Unavailable({ service: "endings", detail })

/**
 * The record's text; empty when the file does not exist yet.
 */
const text = (path: string): Effect.Effect<string, Unavailable, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.exists(path)) ? yield* fs.readFileString(path) : ""
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))))

const linesOf = (recorded: string): ReadonlyArray<typeof Line.Type> =>
  recorded.split("\n").flatMap((line) => {
    const decoded = decodeLine(line)
    return decoded._tag === "Some" ? [decoded.value] : []
  })

/**
 * Every ending the file holds, oldest first. A line that is not an ending,
 * such as one cut short by a crash, is passed over.
 *
 * @category accessors
 * @since 0.1.0
 */
export const read = (
  path: string
): Effect.Effect<ReadonlyArray<typeof Line.Type>, Unavailable, FileSystem.FileSystem> => Effect.map(text(path), linesOf)

/**
 * Appends the endings whose change the file does not hold yet, in one write.
 * A file whose last line was cut short gets a line break first, so a new
 * line never joins a broken one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const record = (
  path: string,
  endings: ReadonlyArray<typeof Ending.Type>
): Effect.Effect<void, Unavailable, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const recorded = yield* text(path)
    const held = new Set(linesOf(recorded).map((line) => line.id))
    const at = yield* Clock.currentTimeMillis
    const fresh = endings.filter((ending, index) =>
      !held.has(ending.id) && endings.findIndex((other) => other.id === ending.id) === index
    )
    if (fresh.length === 0) return
    const lines = fresh.map((ending) => JSON.stringify({ ...ending, at }) + "\n").join("")
    yield* fs.writeFileString(path, (recorded === "" || recorded.endsWith("\n") ? "" : "\n") + lines, { flag: "a" })
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))))

/**
 * The `Endings` record over a file.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: { readonly path: string }): Layer.Layer<Endings, never, FileSystem.FileSystem> =>
  Layer.effect(
    Endings,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return Endings.of({
        record: (endings) => record(options.path, endings).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      })
    })
  )
