/**
 * The inbox as a file: one JSON letter per line, appended by whoever hands a
 * change to the queue, read by the queue from its cursor.
 *
 * It needs only Effect's `FileSystem`, so it runs wherever a host provides
 * one. A line that is not a letter is passed over but still counts toward the
 * cursor, so one bad line never stops the queue or shifts the letters after
 * it.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Letter } from "./Services.ts"
import { Inbox, Unavailable } from "./Services.ts"

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One line of the inbox file.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Line = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("enqueue"), id: Natural, priority: Natural }),
  Schema.Struct({ _tag: Schema.Literal("withdraw"), id: Natural }),
  Schema.Struct({ _tag: Schema.Literal("close") })
])

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line))

/**
 * Where the inbox file is, and how often the queue looks for new lines.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly path: string
  readonly poll: Duration.Input
}

const unavailable = (detail: string) => new Unavailable({ service: "inbox", detail })

/**
 * The lines of the inbox file; none when the file does not exist yet.
 *
 * @category accessors
 * @since 0.1.0
 */
export const lines = (path: string): Effect.Effect<ReadonlyArray<string>, Unavailable, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path)
    if (!exists) return []
    const text = yield* fs.readFileString(path)
    return text.split("\n").filter((line) => line.trim() !== "")
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))))

/**
 * The letter a line holds, or `undefined` for a line that is not a letter.
 *
 * @category accessors
 * @since 0.1.0
 */
export const letter = (line: string): Letter | undefined => {
  const decoded = decodeLine(line)
  if (decoded._tag === "None") return undefined
  return decoded.value._tag === "close" ? { _tag: "close" } : { _tag: "event", event: decoded.value }
}

/**
 * Appends one letter to the inbox file. This is what an `enqueue` command
 * calls.
 *
 * @category constructors
 * @since 0.1.0
 */
export const append = (
  path: string,
  line: typeof Line.Type
): Effect.Effect<void, Unavailable, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(path, JSON.stringify(line) + "\n", { flag: "a" })
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))))

/**
 * The `Inbox` over a file.
 *
 * `since` skips lines that are not letters but counts them, so the cursor is
 * always a line number. `wait` polls the file; a read that fails is tried
 * again at the next poll.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options): Layer.Layer<Inbox, never, FileSystem.FileSystem> =>
  Layer.effect(
    Inbox,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const read = lines(options.path).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      return Inbox.of({
        since: (cursor) =>
          Effect.map(read, (all) => all.slice(cursor).map((line): Letter => letter(line) ?? { _tag: "skip" })),
        wait: (cursor) =>
          read.pipe(
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
            Effect.repeat({ until: (all) => all.length > cursor, schedule: Schedule.spaced(options.poll) }),
            Effect.asVoid
          )
      })
    })
  )
