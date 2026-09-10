/**
 * The session registry: which Durable Object holds the app's session list, and
 * how a row of that list is derived.
 *
 * A Durable Object namespace cannot be enumerated, so `GET /api/session` reads
 * one well-known object instead. {@link INDEX_SESSION} names it. Every session
 * registers with that object on its first turn and updates it as the turn
 * settles, so the Recent column is a single read of a single object rather
 * than a fan-out over every session that ever existed.
 *
 * The type-only `Env` import keeps this module free of `cloudflare:workers`,
 * so the router and its tests can import it without the Durable Object class.
 */
import type { Env } from "./env.ts"

/** The Durable Object name that holds the session list. */
export const INDEX_SESSION = "index"

/** The stub for one session id. */
export const sessionOf = (env: Env, sessionId: string) => env.SESSIONS.get(env.SESSIONS.idFromName(sessionId))

/** The stub for the registry object. */
export const indexSession = (env: Env) => sessionOf(env, INDEX_SESSION)

/** How much of the first message the Recent column shows. */
const TITLE_LIMIT = 72

/**
 * A Recent-column title from a user message.
 *
 * The column is one line, so newlines and runs of spaces collapse and a long
 * message is cut at a word boundary. An empty message keeps the row readable
 * rather than rendering a blank button.
 */
export const titleFrom = (message: string): string => {
  const oneLine = message.replace(/\s+/g, " ").trim()
  if (oneLine.length === 0) return "Untitled session"
  if (oneLine.length <= TITLE_LIMIT) return oneLine
  const cut = oneLine.slice(0, TITLE_LIMIT)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > TITLE_LIMIT / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
