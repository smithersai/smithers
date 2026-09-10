/**
 * The checks every API request passes before it reaches a Durable Object:
 * credential, browser origin, JSON media type, body size, and session-id shape.
 *
 * They live here rather than inline in the switch because each one is a
 * security claim `README.md` and `worker/README.md` make, and a claim a test
 * can drive directly is a claim that stays true. The API shipped with none of
 * them while `CreateApp` ships `deploy` as a first-class target with a custom
 * domain, so a deployed app let any caller allocate unbounded Durable Object
 * storage, read or overwrite any session id it guessed, and post a body of any
 * size.
 *
 * What these bounds are NOT: they are not tenancy. One shared token means one
 * tenant, so a holder of the token still reaches every session. Per-session
 * storage growth, model spend, and request rate stay unbounded. `worker/README.md`
 * says so in the same words.
 */
import { INDEX_SESSION } from "./registry.ts"

/**
 * The shape a session id must have before it names a Durable Object.
 *
 * The shell mints `ses_<uuid>` (`src/shell/store.ts`), and this accepts that
 * plus any other flat identifier. What it refuses is what matters: a separator
 * or whitespace, a leading punctuation character, an empty string, and anything
 * past 128 characters, so a caller cannot name an object with a megabyte of
 * text or a path-shaped string that reads like a traversal.
 */
export const SESSION_ID = /^[A-Za-z0-9][\w.:-]{0,127}$/

/**
 * Whether `value` may name a session's Durable Object.
 *
 * {@link INDEX_SESSION} is refused separately from the shape: it is the
 * well-known object holding the session list, and a caller that addressed it as
 * an ordinary session wrote its own transcript into the registry's tables.
 */
export const isSessionId = (value: string): boolean => value !== INDEX_SESSION && SESSION_ID.test(value)

/**
 * The largest JSON body any route accepts.
 *
 * A turn message, a cancel, and a flow-run payload are all small. The cap is
 * generous for each and still bounds what one anonymous request can make this
 * Worker buffer.
 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * A decoded body, or the refusal the route should answer with.
 *
 * `400` keeps the shape the routes already answered for a body that does not
 * decode; `413` bounds size and `415` refuses a non-JSON media type.
 */
export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly message: string }

const tooLarge = (limit: number): BodyResult => ({
  ok: false,
  status: 413,
  message: `Request body is larger than ${limit} bytes.`
})

/**
 * Reads a JSON body without ever buffering more than `limit` bytes.
 *
 * The media type must be application/json. Then `content-length` refuses an
 * oversized body before a byte is read. The running total also bounds a body that
 * declares no length. Passing the cap cancels the source rather than
 * draining it.
 */
export const readJson = async (request: Request, limit: number = MAX_BODY_BYTES): Promise<BodyResult> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, message: "Expected Content-Type: application/json." }
  }

  const declared = request.headers.get("content-length")
  if (declared !== null && Number(declared) > limit) return tooLarge(limit)

  const body = request.body
  if (body === null) return { ok: false, status: 400, message: "Expected a JSON body." }

  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return tooLarge(limit)
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, status: 400, message: "Request body could not be read." }
  }

  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buffer)) as unknown }
  } catch {
    return { ok: false, status: 400, message: "Request body is not JSON." }
  }
}

/**
 * Compares two strings without leaking where they first differ.
 *
 * A credential check that returns on the first mismatched character tells a
 * caller how much of its guess was right, so the whole string is walked and the
 * differences accumulated. The length check ahead of it leaks only the length,
 * which a bearer token does not hide anyway.
 */
const sameSecret = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

/**
 * Whether this request carries the credential `env.APP_API_TOKEN` names.
 *
 * Missing or empty credentials fail closed unless local development explicitly
 * opts in with APP_API_OPEN=1. A configured token always takes precedence.
 */
export const authorized = (request: Request, token: string | undefined, open?: string): boolean => {
  if (token === undefined || token === "") return open === "1"
  const header = request.headers.get("authorization")
  if (header === null) return false
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return false
  return sameSecret(header.slice(prefix.length), token)
}

/** Browser metadata must name this origin; absent headers support non-browser clients. */
export const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  return (origin === null || origin === new URL(request.url).origin)
    && (site === null || site === "same-origin")
}
