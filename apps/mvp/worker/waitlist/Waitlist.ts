import { Effect, Metric, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  WAITLIST_JOIN_ROUTE,
  WAITLIST_MAX_BODY_BYTES,
  WAITLIST_MAX_NOTE_LENGTH,
  WAITLIST_MAX_URL_LENGTH,
  type WaitlistJoinResponse,
} from "../../src/features/waitlist/contract.ts"
import { Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/
const GITHUB_SEGMENT = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const NO_STORE = { "cache-control": "no-store" }

export const waitlistJoins = Metric.counter("smithers_waitlist_joins", {
  description: "Repository hosting waitlist join requests by outcome",
  incremental: true,
})

export const handles = (path: string): boolean => path === WAITLIST_JOIN_ROUTE

/**
 * Normalize and validate an HTTPS repository URL for waitlist intake.
 * Rejects non-HTTPS schemes, embedded credentials, non-default ports, control characters,
 * blank paths, and non-root GitHub URLs.
 */
export function normalizeWaitlistUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > WAITLIST_MAX_URL_LENGTH) return undefined
  if (CONTROL_CHARS.test(trimmed)) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:") return undefined
  if (parsed.username !== "" || parsed.password !== "") return undefined
  if (parsed.port !== "") return undefined
  const host = parsed.hostname.toLowerCase()
  if (host.length === 0 || !host.includes(".")) return undefined
  const cleanPath = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()
  if (cleanPath === "" || cleanPath === "/") return undefined
  if (host === "github.com") {
    const segments = cleanPath.split("/").filter((seg) => seg.length > 0)
    if (segments.length !== 2) return undefined
    const [owner, repo] = segments
    if (!GITHUB_SEGMENT.test(owner!) || !GITHUB_SEGMENT.test(repo!)) return undefined
    return `https://github.com/${owner}/${repo}`
  }
  return `https://${host}${cleanPath}`
}

function normalizeNote(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return ""
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (trimmed.length > WAITLIST_MAX_NOTE_LENGTH || CONTROL_CHARS.test(trimmed)) return undefined
  return trimmed
}

const json = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE })

export const join = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (request.method !== "POST") {
    return HttpServerResponse.empty({ status: 405, headers: { ...NO_STORE, allow: "POST" } })
  }

  const sessions = yield* Sessions
  const actorOpt = yield* sessions.resolve
  if (Option.isNone(actorOpt)) {
    const hasAuth = request.headers.authorization !== undefined || request.headers["x-smithers-device-person"] !== undefined
    if (hasAuth) {
      yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "authentication" }), 1)
      return json(401, { error: "authentication" })
    }
  }
  if (Option.isSome(actorOpt) && actorOpt.value.act !== undefined) {
    yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "person_only" }), 1)
    return json(403, { error: "person_only" })
  }
  const signedIn = Option.isSome(actorOpt)
  const requester = signedIn ? `person:${actorOpt.value.subject.id}` : "anonymous"

  const rawBody = yield* readBounded(request, WAITLIST_MAX_BODY_BYTES).pipe(
    Effect.match({
      onFailure: (err) => ({ ok: false as const, reason: err.reason }),
      onSuccess: (text) => ({ ok: true as const, text }),
    }),
  )
  if (!rawBody.ok) {
    const status = rawBody.reason === "too_large" ? 413 : 400
    yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "rejected" }), 1)
    return json(status, { error: rawBody.reason === "too_large" ? "too_large" : "invalid_body" })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody.text)
  } catch {
    yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "invalid_json" }), 1)
    return json(400, { error: "invalid_json" })
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "invalid_payload" }), 1)
    return json(400, { error: "invalid_payload" })
  }

  const record = payload as Record<string, unknown>
  const repoUrl = normalizeWaitlistUrl(record["repoUrl"])
  const workflowNote = normalizeNote(record["workflowNote"])
  if (repoUrl === undefined || workflowNote === undefined) {
    yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "invalid_url" }), 1)
    return json(400, { error: "invalid_repo_url" })
  }

  const storedNote = signedIn ? workflowNote : ""
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly position: string | number; readonly normalized_url: string }>`
    INSERT INTO waitlist_entries (normalized_url, requester, workflow_note)
    VALUES (${repoUrl}, ${requester}, ${storedNote})
    ON CONFLICT (normalized_url, requester)
    DO UPDATE SET workflow_note = CASE
      WHEN waitlist_entries.requester = 'anonymous' THEN ''
      WHEN waitlist_entries.workflow_note = '' THEN EXCLUDED.workflow_note
      ELSE waitlist_entries.workflow_note
    END
    RETURNING position, normalized_url`

  const row = rows[0]!
  const response: WaitlistJoinResponse = {
    status: "submitted",
    repoUrl: row.normalized_url,
    position: Number(row.position),
  }
  yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "submitted" }), 1)
  return json(200, response)
}).pipe(
  Effect.catch(() =>
    Effect.gen(function* () {
      yield* Metric.update(Metric.withAttributes(waitlistJoins, { outcome: "unavailable" }), 1)
      return json(503, { error: "unavailable" })
    }),
  ),
  Effect.withSpan("waitlist.join"),
)
