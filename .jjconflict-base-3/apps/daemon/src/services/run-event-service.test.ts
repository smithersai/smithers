import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"

import { insertRunEventRow, deleteRunEventRowsByWorkspaceId } from "@/db/repositories/run-event-repository"
import { deleteWorkspaceRowById, insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { listRunEvents, persistSmithersEvent } from "@/services/run-event-service"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const workspaceIdsToCleanup = new Set<string>()
const workspacePathsToCleanup = new Set<string>()

function seedWorkspace() {
  const workspaceId = `test-run-events-${randomUUID()}`
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  const now = new Date().toISOString()

  mkdirSync(path.join(workspacePath, ".smithers", "state"), { recursive: true })
  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  workspaceIdsToCleanup.add(workspaceId)
  workspacePathsToCleanup.add(workspacePath)
  return { workspaceId, workspacePath }
}

afterEach(() => {
  for (const workspaceId of workspaceIdsToCleanup) {
    deleteRunEventRowsByWorkspaceId(workspaceId)
    deleteWorkspaceRowById(workspaceId)
  }
  workspaceIdsToCleanup.clear()

  for (const workspacePath of workspacePathsToCleanup) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToCleanup.clear()
})

describe("run event service", () => {
  it("deduplicates replayed Smithers payloads when seq is missing", () => {
    const { workspaceId } = seedWorkspace()
    const runId = "run-with-replayed-events"
    const payload = {
      type: "NodeOutput",
      runId,
      nodeId: "determine-intent",
      iteration: 0,
      attempt: 1,
      stream: "stderr",
      text: "line one\\nline two",
      timestampMs: 1773336687918,
    }

    const first = persistSmithersEvent(workspaceId, runId, payload)
    const second = persistSmithersEvent(workspaceId, runId, payload)
    const events = listRunEvents(workspaceId, runId)

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      seq: 1,
      runId,
      type: "NodeOutput",
      nodeId: "determine-intent",
      rawPayload: {
        text: "line one\\nline two",
      },
    })
  })

  it("hydrates missing raw payloads from workspace Smithers events", () => {
    const { workspaceId, workspacePath } = seedWorkspace()
    const runId = "run-with-node-output"
    const timestamp = "2026-03-12T18:10:00.000Z"
    const smithersDbPath = path.join(workspacePath, ".smithers", "state", "smithers.db")
    const smithersDb = new Database(smithersDbPath, { create: true })

    try {
      smithersDb.exec(`
        CREATE TABLE IF NOT EXISTS _smithers_events (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
      `)

      smithersDb
        .query(
          `
            INSERT INTO _smithers_events (
              run_id,
              seq,
              payload_json
            ) VALUES (?1, ?2, ?3)
          `
        )
        .run(
          runId,
          50,
          JSON.stringify({
            type: "NodeOutput",
            runId,
            nodeId: "search-codebase-structure",
            iteration: 0,
            attempt: 1,
            text: "agent output line",
            stream: "stdout",
            timestampMs: 1773334762788,
          })
        )
    } finally {
      smithersDb.close()
    }

    insertRunEventRow(workspaceId, {
      seq: 50,
      runId,
      type: "NodeOutput",
      timestamp,
      nodeId: "search-codebase-structure",
      message: undefined,
    })

    const events = listRunEvents(workspaceId, runId)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      seq: 50,
      runId,
      type: "NodeOutput",
      nodeId: "search-codebase-structure",
      rawPayload: {
        text: "agent output line",
        stream: "stdout",
      },
    })
  })

  it("does not misclassify raw payloads when local and Smithers seq values diverge", () => {
    const { workspaceId, workspacePath } = seedWorkspace()
    const runId = "run-legacy-seq-mismatch"
    const nodeId = "determine-intent"
    const timestamp = "2026-03-12T16:59:11.151Z"
    const smithersDbPath = path.join(workspacePath, ".smithers", "state", "smithers.db")
    const smithersDb = new Database(smithersDbPath, { create: true })

    try {
      smithersDb.exec(`
        CREATE TABLE IF NOT EXISTS _smithers_events (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
      `)

      smithersDb
        .query(
          `
            INSERT INTO _smithers_events (
              run_id,
              seq,
              payload_json
            ) VALUES (?1, ?2, ?3)
          `
        )
        .run(
          runId,
          3,
          JSON.stringify({
            type: "NodeOutput",
            runId,
            nodeId,
            iteration: 0,
            attempt: 1,
            text: "output chunk",
            stream: "stderr",
            timestampMs: 1773334685827,
          })
        )

      smithersDb
        .query(
          `
            INSERT INTO _smithers_events (
              run_id,
              seq,
              payload_json
            ) VALUES (?1, ?2, ?3)
          `
        )
        .run(
          runId,
          24,
          JSON.stringify({
            type: "NodeFinished",
            runId,
            nodeId,
            iteration: 0,
            attempt: 1,
            timestampMs: 1773334751151,
          })
        )
    } finally {
      smithersDb.close()
    }

    insertRunEventRow(workspaceId, {
      seq: 3,
      runId,
      type: "NodeFinished",
      timestamp,
      nodeId,
      message: undefined,
    })

    const events = listRunEvents(workspaceId, runId)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      seq: 3,
      runId,
      type: "NodeFinished",
      nodeId,
      rawPayload: {
        type: "NodeFinished",
        attempt: 1,
      },
    })
    expect(events[0]?.rawPayload).not.toMatchObject({
      type: "NodeOutput",
    })
  })
})
