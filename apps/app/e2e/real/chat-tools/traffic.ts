import { AgentTurnFrameSchema, type AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { AgentTurnJournalDeliverySchema, type AgentTurnCursor, type AgentTurnBatch } from "@smthrs/rpc/AgentTurnJournal"
import { verifyHttpBatch } from "../../../src/mainview/state/HttpTurn"

export type TurnTrafficProtocol = "journal-v1" | "legacy"
export type TurnFrame = AgentTurnFrame & Partial<Record<"kind" | "text" | "reason" | "error" | "name" | "arguments", unknown>> & {
  /** The observed commit boundary covers the whole batch, not this frame alone. */
  readonly journal?: { readonly accepted: AgentTurnCursor; readonly cursor: AgentTurnCursor; readonly position: number }
}
export type TurnTrafficOptions = { readonly protocol?: TurnTrafficProtocol }

export const assertTurnTrafficProtocol = (headers: Readonly<Record<string, unknown>>, protocol: TurnTrafficProtocol): void => {
  const version = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-smithers-turn-journal")?.[1]
  if (protocol === "journal-v1" ? version !== "1" : version !== undefined) {
    throw new Error(`The observed turn response does not use the requested ${protocol} protocol.`)
  }
}

const sameCursor = (left: AgentTurnCursor, right: AgentTurnCursor): boolean =>
  left.version === right.version && left.runId === right.runId && left.legId === right.legId &&
  left.batch === right.batch && left.position === right.position && left.hash === right.hash

/** Inspect only complete NDJSON records; an incomplete network chunk is never terminal evidence.
 * This observes the initial turn transport. A partial/lost transport or an
 * `existing` acknowledgement requires separate replay evidence, not an invented
 * terminal frame. The real recovery browser test covers that replay path.
 */
export const inspectTurnTraffic = (body: string, { protocol = "journal-v1" }: TurnTrafficOptions = {}): {
  readonly frames: readonly TurnFrame[]; readonly complete: boolean; readonly cursor?: AgentTurnCursor
} => {
  const lines = body.split("\n"), tail = lines.pop()!
  const frames: TurnFrame[] = []
  let accepted: AgentTurnCursor | undefined, cursor: AgentTurnCursor | undefined
  let terminal = false, caughtUp = false, legacyRunId: string | undefined
  for (const line of lines) {
    if (line.trim() === "") continue
    const value: unknown = JSON.parse(line)
    if (protocol === "legacy") {
      const frame = AgentTurnFrameSchema.parse(value)
      if (terminal || (legacyRunId !== undefined && frame.runId !== legacyRunId)) throw new Error("Legacy turn frames do not extend one observed turn.")
      legacyRunId = frame.runId
      frames.push(frame)
      terminal = frame.type === "done"
      continue
    }
    const delivery = AgentTurnJournalDeliverySchema.parse(value)
    if (delivery.type === "accepted") {
      if (accepted !== undefined || delivery.cursor.batch !== 0 || delivery.cursor.position !== 0) {
        throw new Error("The observed turn is missing its initial acceptance boundary.")
      }
      accepted = cursor = delivery.cursor
    } else if (delivery.type === "batch") {
      if (!accepted || !cursor || terminal || caughtUp) throw new Error("The observed batch is outside an active accepted prefix.")
      // Reuse the active browser's verifier; this observation owns no credentials,
      // persisted turn rows or side effects. The local identity links its scope.
      const next = verifyHttpBatch({ id: accepted.legId, turnId: accepted.runId, legId: accepted.legId, status: "active" },
        { id: accepted.legId, attemptId: accepted.legId, status: "streaming", cursor }, (value as { readonly batch: AgentTurnBatch }).batch)
      if (!next || !sameCursor(next, delivery.cursor)) throw new Error("The observed batch cursor does not match its committed frames.")
      cursor = delivery.cursor
      frames.push(...delivery.batch.frames.map((frame, index) => ({ ...frame,
        journal: { accepted: accepted!, cursor: delivery.cursor, position: delivery.batch.from + index } })))
      terminal = delivery.batch.frames.at(-1)?.type === "done"
    } else {
      if (!cursor || caughtUp || !sameCursor(cursor, delivery.cursor) || delivery.terminal !== terminal) {
        throw new Error("The catch-up observation does not match the observed terminal prefix.")
      }
      caughtUp = true
    }
  }
  return { frames, complete: terminal && tail.trim() === "", ...(cursor ? { cursor } : {}) }
}

/** Keep response and frame order as observed. Never fill missing output from a head or cursor. */
export const parseTurnFrames = (bodies: readonly string[], options: TurnTrafficOptions = {}): readonly TurnFrame[] => {
  if (bodies.length === 0) throw new Error("No turn traffic was observed.")
  return bodies.flatMap(body => {
    const observation = inspectTurnTraffic(body, options)
    if (!observation.complete) throw new Error("The observed turn traffic is incomplete: a complete terminal frame is required.")
    return observation.frames
  })
}
