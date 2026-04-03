import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { createApp } from "@/server/app"

const originalFetch = globalThis.fetch
const workspacePathsToDelete = new Set<string>()

function createSmithersSseResponse(frames: string[]) {
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${frame}\n\n`))
        }
        controller.close()
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
      },
    }
  )
}

async function waitForRunEvents(params: {
  app: ReturnType<typeof createApp>
  workspaceId: string
  runId: string
  predicate: (events: Array<{ seq: number; type: string; message?: string; rawPayload?: unknown }>) => boolean
}) {
  const deadline = Date.now() + 2_500

  while (Date.now() < deadline) {
    const response = await params.app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${params.workspaceId}/runs/${params.runId}/events`,
        {
          method: "GET",
        }
      )
    )
    const events = (await response.json()) as Array<{
      seq: number
      type: string
      message?: string
      rawPayload?: unknown
    }>
    if (params.predicate(events)) {
      return events
    }

    await Bun.sleep(25)
  }

  return []
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
})

describe("workspace run flow (e2e)", () => {
  it("creates workspace, starts run, and persists task output events", async () => {
    const app = createApp()
    const suffix = randomUUID().slice(0, 8)
    const workspaceName = `e2e-${suffix}`

    const createResponse = await app.fetch(
      new Request("http://localhost:7332/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: workspaceName,
          sourceType: "create",
          targetFolder: workspaceName,
          runtimeMode: "burns-managed",
        }),
      })
    )

    expect(createResponse.status).toBe(201)
    const workspace = (await createResponse.json()) as {
      id: string
      path: string
    }
    workspacePathsToDelete.add(workspace.path)

    const workflowsResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspace.id}/workflows`, {
        method: "GET",
      })
    )
    expect(workflowsResponse.status).toBe(200)
    const workflows = (await workflowsResponse.json()) as Array<{ id: string }>
    expect(workflows.length).toBeGreaterThan(0)

    const workflowId = workflows[0]!.id
    const runId = "run-e2e-001"
    const approvalNodeId = "deploy-gate"
    let streamRequestCount = 0
    const capturedApproveUrls: string[] = []

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.includes(`/v1/runs/${runId}/events`) && method === "GET") {
        streamRequestCount += 1
        return createSmithersSseResponse([
          `event: smithers\ndata: {"seq":1,"runId":"${runId}","type":"run.started","message":"run started"}`,
          `event: smithers\ndata: {"seq":2,"runId":"${runId}","type":"approval.pending","nodeId":"${approvalNodeId}","message":"waiting for approval"}`,
          `event: smithers\ndata: {"seq":3,"runId":"${runId}","type":"task.output","nodeId":"echo-task","message":"hello e2e"}`,
          `event: smithers\ndata: {"seq":4,"runId":"${runId}","type":"run.finished","message":"run finished"}`,
        ])
      }

      if (url.endsWith("/v1/runs") && method === "POST") {
        return Response.json({
          run: {
            id: runId,
            workflowId,
            workflowName: workflowId,
            status: "running",
            startedAt: "2026-03-11T23:00:00.000Z",
            summary: {
              finished: 0,
              inProgress: 1,
              pending: 0,
            },
          },
        })
      }

      if (url.includes(`/v1/runs/${runId}`) && method === "GET") {
        return Response.json({
          run: {
            id: runId,
            workflowId,
            workflowName: workflowId,
            status: "finished",
            startedAt: "2026-03-11T23:00:00.000Z",
            finishedAt: "2026-03-11T23:00:02.000Z",
            summary: {
              finished: 1,
              inProgress: 0,
              pending: 0,
            },
          },
        })
      }

      if (url.includes(`/v1/runs/${runId}/nodes/${approvalNodeId}/approve`) && method === "POST") {
        capturedApproveUrls.push(url)
        return Response.json({ ok: true })
      }

      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    const startRunResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspace.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId,
          input: {
            task: "echo hello",
          },
        }),
      })
    )

    expect(startRunResponse.status).toBe(201)
    const startedRun = (await startRunResponse.json()) as { id: string; status: string }
    expect(startedRun).toMatchObject({
      id: runId,
      status: "running",
    })

    const persistedEvents = await waitForRunEvents({
      app,
      workspaceId: workspace.id,
      runId,
      predicate: (events) => events.some((event) => event.type === "approval.pending"),
    })

    const pendingApprovalsResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspace.id}/approvals`, {
        method: "GET",
      })
    )
    expect(pendingApprovalsResponse.status).toBe(200)
    const pendingApprovals = (await pendingApprovalsResponse.json()) as Array<{
      status: string
      runId: string
      nodeId: string
    }>
    expect(
      pendingApprovals.some(
        (approval) =>
          approval.status === "pending" &&
          approval.runId === runId &&
          approval.nodeId === approvalNodeId
      )
    ).toBe(true)

    const approveResponse = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspace.id}/runs/${runId}/nodes/${approvalNodeId}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedBy: "e2e-bot",
            note: "approved in e2e",
          }),
        }
      )
    )
    expect(approveResponse.status).toBe(200)
    const approved = (await approveResponse.json()) as {
      status: string
      nodeId: string
      runId: string
      decidedBy?: string
    }
    expect(approved).toMatchObject({
      status: "approved",
      runId,
      nodeId: approvalNodeId,
      decidedBy: "e2e-bot",
    })

    const approvalsAfterDecisionResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspace.id}/approvals`, {
        method: "GET",
      })
    )
    expect(approvalsAfterDecisionResponse.status).toBe(200)
    const approvalsAfterDecision = (await approvalsAfterDecisionResponse.json()) as Array<{
      status: string
      runId: string
      nodeId: string
    }>
    expect(
      approvalsAfterDecision.some(
        (approval) =>
          approval.status === "approved" &&
          approval.runId === runId &&
          approval.nodeId === approvalNodeId
      )
    ).toBe(true)

    const completedEvents = await waitForRunEvents({
      app,
      workspaceId: workspace.id,
      runId,
      predicate: (events) => events.some((event) => event.type === "run.finished"),
    })

    expect(streamRequestCount).toBeGreaterThan(0)
    expect(capturedApproveUrls).toHaveLength(1)
    expect(
      completedEvents.some(
        (event) => event.type === "task.output" && event.message?.includes("hello e2e")
      )
    ).toBe(true)
    expect(
      completedEvents.some((event) => event.type === "approval.approved")
    ).toBe(true)
    expect(
      persistedEvents.some(
        (event) =>
          event.type === "approval.pending" &&
          event.message?.includes("waiting for approval") &&
          typeof event.rawPayload === "object"
      )
    ).toBe(true)
  })
})
