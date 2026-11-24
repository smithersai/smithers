/**
 * Fits a host's replacement snapshot of its sessions (`fleet_sessions_report`) under MCP's request limit
 * (R2-Astra-D4-011). Pure, with no runtime imports, so the daemon and its tests share one plan.
 *
 * A plan first drops optional transcript detail, oldest entries first, until the whole snapshot fits one request.
 * A snapshot whose sessions do not fit even at `MIN_TRANSCRIPT_ENTRIES` each (or exceed `MAX_SESSIONS_PER_REPORT`)
 * is sent as bounded chunks under one `snapshotId`: the server stages every chunk and ends the host's missing
 * sessions only on the final one.
 *
 * @since 1.0.0
 */

/**
 * The most bytes one `fleet_sessions_report` argument object may serialize to. MCP refuses a request body over
 * 262,144 bytes (`MCP_MAX_REQUEST_BYTES`); this leaves 62,144 bytes for the JSON-RPC envelope and headroom.
 *
 * @since 1.0.0
 * @category constants
 */
export const FLEET_REPORT_MAX_BYTES = 200_000

/**
 * The newest transcript entries a session keeps before a snapshot is chunked instead of trimmed further.
 *
 * @since 1.0.0
 * @category constants
 */
export const MIN_TRANSCRIPT_ENTRIES = 4

/**
 * The most sessions one `fleet_sessions_report` request may carry (matches `FleetStore.MAX_SESSIONS_PER_REPORT`).
 *
 * @since 1.0.0
 * @category constants
 */
export const MAX_SESSIONS_PER_REPORT = 500

/**
 * What a plan reads of a session: its other fields pass through untouched.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReportableSession {
  readonly sessionKey: string
  readonly transcriptJson?: ReadonlyArray<unknown> | null | undefined
}

/**
 * One `fleet_sessions_report` call's arguments.
 *
 * @since 1.0.0
 * @category models
 */
export type SessionsReportRequest<S extends ReportableSession> = {
  readonly nodeId: string
  readonly replaceActive: true
  readonly sessions: ReadonlyArray<S>
  readonly snapshotId?: string
  readonly chunkIndex?: number
  readonly totalChunks?: number
  readonly final?: boolean
}

const encoder = new TextEncoder()

/**
 * The bytes `value` takes as a JSON request body.
 *
 * @since 1.0.0
 * @category planning
 */
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

const capTranscript = <S extends ReportableSession>(session: S, cap: number): S => {
  const transcript = session.transcriptJson
  if (transcript === undefined || transcript === null || transcript.length <= cap) return session
  return { ...session, transcriptJson: cap === 0 ? null : transcript.slice(-cap) }
}

/**
 * `sessions` with each transcript cut to its newest entries, by the largest per-session count at which the list
 * serializes to at most `maxBytes`, and never below `floor`. Every session and every other field is kept.
 *
 * @since 1.0.0
 * @category planning
 */
export function trimTranscripts<S extends ReportableSession>(
  sessions: ReadonlyArray<S>,
  maxBytes: number,
  floor: number = MIN_TRANSCRIPT_ENTRIES
): ReadonlyArray<S> {
  if (jsonBytes(sessions) <= maxBytes) return sessions
  const longest = sessions.reduce((most, session) => Math.max(most, session.transcriptJson?.length ?? 0), 0)
  let trimmed = sessions
  for (let cap = longest - 1; cap >= floor; cap -= 1) {
    trimmed = sessions.map((session) => capTranscript(session, cap))
    if (jsonBytes(trimmed) <= maxBytes) break
  }
  return trimmed
}

/**
 * The requests that deliver `sessions` as one replacement snapshot of `nodeId`, each at most `maxBytes` of arguments
 * and at most `maxSessionsPerChunk` sessions. One request, with no snapshot fields, when the trimmed snapshot fits.
 * Otherwise chunks under `snapshotId`, in order, the last one `final`. A session too large for a request of its own
 * is sent without its transcript.
 *
 * @since 1.0.0
 * @category planning
 */
export function planSessionsReport<S extends ReportableSession>(input: {
  readonly nodeId: string
  readonly sessions: ReadonlyArray<S>
  readonly snapshotId: string
  readonly maxBytes?: number
  readonly maxSessionsPerChunk?: number
}): ReadonlyArray<SessionsReportRequest<S>> {
  const maxBytes = input.maxBytes ?? FLEET_REPORT_MAX_BYTES
  const maxSessionsPerChunk = Math.max(1, input.maxSessionsPerChunk ?? MAX_SESSIONS_PER_REPORT)
  // The arguments around the session list, at their widest.
  const envelope = jsonBytes({
    nodeId: input.nodeId,
    replaceActive: true,
    snapshotId: input.snapshotId,
    chunkIndex: 2_147_483_647,
    totalChunks: 2_147_483_647,
    final: false,
    sessions: []
  })
  const room = Math.max(maxBytes - envelope, 0)
  const trimmed = trimTranscripts(input.sessions, room)
  if (trimmed.length === 0 || (trimmed.length <= maxSessionsPerChunk && jsonBytes(trimmed) <= room)) {
    return [{ nodeId: input.nodeId, replaceActive: true, sessions: trimmed }]
  }
  const chunks: Array<Array<S>> = []
  let current: Array<S> = []
  // The list's brackets.
  let used = 2
  for (const session of trimmed) {
    const whole = jsonBytes(session) + 1
    const fitted = whole + 2 <= room ? session : capTranscript(session, 0)
    const size = fitted === session ? whole : jsonBytes(fitted) + 1
    if (current.length > 0 && (current.length >= maxSessionsPerChunk || used + size > room)) {
      chunks.push(current)
      current = []
      used = 2
    }
    current.push(fitted)
    used += size
  }
  chunks.push(current)
  return chunks.map((sessions, chunkIndex) => ({
    nodeId: input.nodeId,
    replaceActive: true,
    sessions,
    snapshotId: input.snapshotId,
    chunkIndex,
    totalChunks: chunks.length,
    final: chunkIndex === chunks.length - 1
  }))
}
