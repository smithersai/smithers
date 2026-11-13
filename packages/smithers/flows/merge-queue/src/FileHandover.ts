/**
 * The hand-over as a file: the position the last lineage ended on, as one
 * JSON document, replaced whole.
 *
 * A host reads it when a run of the queue flow ends: `done` false means start
 * the next lineage with `position` as its start value. The file is written
 * beside itself and renamed into place, so a reader sees the old position or
 * the new one and never half of one.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Handover, Unavailable } from "./Services.ts"

/**
 * What the file holds.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Document = Schema.Struct({ done: Schema.Boolean, position: Schema.Unknown })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Document))

const unavailable = (detail: string) => new Unavailable({ service: "handover", detail })

/**
 * The hand-over the file holds, or `undefined` before any lineage has ended.
 *
 * @category accessors
 * @since 0.1.0
 */
export const read = (
  path: string
): Effect.Effect<typeof Document.Type | undefined, Unavailable, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(path))) return undefined
    return yield* decode(yield* fs.readFileString(path))
  }).pipe(
    Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))),
    Effect.catchTag(
      "SchemaError",
      (error) => Effect.fail(unavailable(`the hand-over is not readable: ${error.message}`))
    )
  )

/**
 * Replaces the hand-over the file holds.
 *
 * @category constructors
 * @since 0.1.0
 */
export const save = (
  path: string,
  handover: typeof Document.Type
): Effect.Effect<void, Unavailable, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${path}.next`, JSON.stringify(handover) + "\n")
    yield* fs.rename(`${path}.next`, path)
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(unavailable(error.message))))

/**
 * The `Handover` over a file.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: { readonly path: string }): Layer.Layer<Handover, never, FileSystem.FileSystem> =>
  Layer.effect(
    Handover,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return Handover.of({
        save: (handover) => save(options.path, handover).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      })
    })
  )
