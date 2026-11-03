import { Data, Effect, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"

// Route-specific UTF-8 and byte limits (docs/features/chat.md#contract). WriteAdmission first buffers raw write
// bodies under its aggregate cap and deadline; each handler then enforces its smaller limit here.

/** Why a body couldn't be read: larger than the route's limit (`too_large`), malformed UTF-8 (`utf8`), or cut off. */
export class BodyRefused extends Data.TaggedError("BodyRefused")<{ readonly reason: "too_large" | "utf8" | "body" }> {}

/**
 * Reads at most `maxBytes` as UTF-8, refusing a declared or streamed body that is larger before buffering it, malformed
 * UTF-8 wherever it falls across chunks, and a body that breaks off. `onBytes` hears how many bytes were read.
 */
export const readBounded = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
  onBytes: (bytes: number) => void = () => {},
): Effect.Effect<string, BodyRefused> => {
  if (Number(request.headers["content-length"]) > maxBytes) return Effect.fail(new BodyRefused({ reason: "too_large" }))
  return Effect.suspend(() => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    const decode = (chunk?: Uint8Array) =>
      Effect.try({
        try: () => (chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true })),
        catch: () => new BodyRefused({ reason: "utf8" }),
      })
    let bytes = 0
    let text = ""
    return request.stream.pipe(
      Stream.mapError(() => new BodyRefused({ reason: "body" })),
      Stream.runForEach((chunk) => {
        bytes += chunk.byteLength
        if (bytes > maxBytes) return Effect.fail(new BodyRefused({ reason: "too_large" }))
        return Effect.map(decode(chunk), (piece) => void (text += piece))
      }),
      Effect.flatMap(() => Effect.map(decode(), (rest) => text + rest)),
      Effect.ensuring(Effect.sync(() => onBytes(bytes))),
    )
  })
}
