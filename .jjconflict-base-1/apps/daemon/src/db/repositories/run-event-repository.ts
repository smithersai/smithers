import type { RunEvent } from "@burns/shared"

import { db } from "@/db/client"

type RunEventRow = {
  workspace_id: string
  run_id: string
  seq: number
  type: string
  timestamp: string
  node_id: string | null
  message: string | null
  raw_payload_json: string | null
  dedupe_key: string | null
}

function parseRawPayload(rawPayloadJson: string | null): unknown {
  if (!rawPayloadJson) {
    return undefined
  }

  try {
    return JSON.parse(rawPayloadJson)
  } catch {
    return rawPayloadJson
  }
}

function stringifyRawPayload(rawPayload: unknown): string | null {
  if (rawPayload === undefined) {
    return null
  }

  try {
    return JSON.stringify(rawPayload)
  } catch {
    return JSON.stringify(String(rawPayload))
  }
}

function mapRunEventRow(row: RunEventRow): RunEvent {
  return {
    seq: row.seq,
    runId: row.run_id,
    type: row.type,
    timestamp: row.timestamp,
    nodeId: row.node_id ?? undefined,
    message: row.message ?? undefined,
    rawPayload: parseRawPayload(row.raw_payload_json),
  }
}

export function listRunEventRows(workspaceId: string, runId: string, afterSeq = 0) {
  const rows = db
    .query<RunEventRow, [string, string, number]>(
      `
        SELECT
          workspace_id,
          run_id,
          seq,
          type,
          timestamp,
          node_id,
          message,
          raw_payload_json,
          dedupe_key
        FROM run_events
        WHERE workspace_id = ?1
          AND run_id = ?2
          AND seq > ?3
        ORDER BY seq ASC
      `
    )
    .all(workspaceId, runId, afterSeq)

  return rows.map(mapRunEventRow)
}

export function getMaxRunEventSeq(workspaceId: string, runId: string) {
  const row = db
    .query<{ max_seq: number | null }, [string, string]>(
      `
        SELECT MAX(seq) AS max_seq
        FROM run_events
        WHERE workspace_id = ?1
          AND run_id = ?2
      `
    )
    .get(workspaceId, runId)

  return row?.max_seq ?? 0
}

export function insertRunEventRow(
  workspaceId: string,
  event: RunEvent & { runId: string },
  options?: { dedupeKey?: string }
) {
  db
    .query(
      `
        INSERT OR IGNORE INTO run_events (
          workspace_id,
          run_id,
          seq,
          type,
          timestamp,
          node_id,
          message,
          raw_payload_json,
          dedupe_key
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `
    )
    .run(
      workspaceId,
      event.runId,
      event.seq,
      event.type,
      event.timestamp,
      event.nodeId ?? null,
      event.message ?? null,
      stringifyRawPayload(event.rawPayload),
      options?.dedupeKey ?? null
    )
}

export function deleteRunEventRowsByWorkspaceId(workspaceId: string) {
  const result = db
    .query(
      `
        DELETE FROM run_events
        WHERE workspace_id = ?1
      `
    )
    .run(workspaceId)

  return result.changes
}
