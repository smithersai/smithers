import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const originalFetch = globalThis.fetch
const workspacePathsToDelete = new Set<string>()

function seedWorkspace() {
  const workspaceId = `test-workspace-${randomUUID()}`
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  const now = new Date().toISOString()
  mkdirSync(workspacePath, { recursive: true })

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: "self-managed",
    smithersBaseUrl: "http://127.0.0.1:7331",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  workspacePathsToDelete.add(workspacePath)
  return workspaceId
}

function writeWorkflowFile(workspaceId: string, workflowId: string, extension: "ts" | "tsx") {
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  const workflowPath = path.join(
    workspacePath,
    ".smithers",
    "workflows",
    workflowId
  )
  mkdirSync(workflowPath, { recursive: true })
  writeFileSync(path.join(workflowPath, `workflow.${extension}`), "export default {}", "utf8")
}

function writeLegacyWorkflowTemplate(workspaceId: string, workflowId: string) {
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  const workflowPath = path.join(
    workspacePath,
    ".smithers",
    "workflows",
    workflowId
  )
  mkdirSync(workflowPath, { recursive: true })
  writeFileSync(
    path.join(workflowPath, "workflow.tsx"),
    `export default smithers(() => (
  <Workflow name="${workflowId}">
    <Task id="plan" output="plan">Legacy template</Task>
  </Workflow>
))`,
    "utf8"
  )
}

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

async function waitForRunEvents(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  runId: string,
  predicate: (events: Array<{ seq: number }>) => boolean
) {
  const deadline = Date.now() + 1_500

  while (Date.now() < deadline) {
    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs/${runId}/events`, {
        method: "GET",
      })
    )
    const events = (await response.json()) as Array<{ seq: number }>
    if (predicate(events)) {
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

describe("run routes", () => {
  it("validates start-run payloads", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "Invalid request",
    })
  })

  it("rejects non-object start-run input payloads", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: ["invalid"],
        }),
      })
    )

    expect(response.status).toBe(400)
  })

  it("rejects non-object resume-run input payloads", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs/run-1/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "invalid",
        }),
      })
    )

    expect(response.status).toBe(400)
  })

  it("maps Smithers list runs responses to Burns run DTOs", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain("/v1/runs")
      expect(init?.method ?? "GET").toBe("GET")

      return Response.json({
        runs: [
          {
            id: "run-123",
            workflowId: "issue-to-pr",
            workflowName: "Issue to PR",
            status: "in-progress",
            summary: {
              done: 2,
              running: 1,
              waiting: 3,
            },
          },
        ],
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "GET",
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      {
        id: "run-123",
        workspaceId,
        workflowId: "issue-to-pr",
        workflowName: "Issue to PR",
        status: "running",
        startedAt: "1970-01-01T00:00:00.000Z",
        finishedAt: null,
        summary: {
          finished: 2,
          inProgress: 1,
          pending: 3,
        },
      },
    ])
  })

  it("forwards start-run requests to Smithers with workflow path metadata", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    writeWorkflowFile(workspaceId, "issue-to-pr", "tsx")
    const capturedBodies: unknown[] = []

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        capturedBodies.push(JSON.parse(init.body))
      }

      return Response.json({
        run: {
          id: "run-created",
          workflow: {
            id: "issue-to-pr",
            name: "issue-to-pr",
          },
          status: "running",
          startedAt: "2026-03-11T11:00:00.000Z",
          summary: {
            finished: 0,
            inProgress: 1,
            pending: 2,
          },
        },
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: {
            task: "sample",
          },
        }),
      })
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      id: "run-created",
      workspaceId,
      workflowId: "issue-to-pr",
      status: "running",
    })
    expect(capturedBodies).toHaveLength(1)
    expect(capturedBodies[0]).toMatchObject({
      input: {
        task: "sample",
      },
      metadata: {
        workspaceId,
        workflowId: "issue-to-pr",
      },
    })
    expect(capturedBodies[0]).toMatchObject({
      workflowPath: expect.stringContaining(`/${workspaceId}/.smithers/workflows/issue-to-pr/workflow.tsx`),
    })
  })

  it("uses workflow.ts when workflow.tsx is absent", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    writeWorkflowFile(workspaceId, "issue-to-pr", "ts")
    const capturedBodies: unknown[] = []

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        capturedBodies.push(JSON.parse(init.body))
      }

      return Response.json({
        run: {
          id: "run-created",
          workflow: {
            id: "issue-to-pr",
            name: "issue-to-pr",
          },
          status: "running",
          startedAt: "2026-03-11T11:00:00.000Z",
          summary: {
            finished: 0,
            inProgress: 1,
            pending: 0,
          },
        },
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: {},
        }),
      })
    )

    expect(response.status).toBe(201)
    expect(capturedBodies).toHaveLength(1)
    expect(capturedBodies[0]).toMatchObject({
      workflowPath: expect.stringContaining(`/${workspaceId}/.smithers/workflows/issue-to-pr/workflow.ts`),
    })
  })

  it("forwards resume-run requests to Smithers with resolved workflow path", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    writeWorkflowFile(workspaceId, "issue-to-pr", "ts")
    const capturedBodies: unknown[] = []

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)

      if (url.includes("/v1/runs/run-7/resume")) {
        if (typeof init?.body === "string") {
          capturedBodies.push(JSON.parse(init.body))
        }

        return Response.json({
          run: {
            id: "run-7",
            workflowId: "issue-to-pr",
            status: "running",
            startedAt: "2026-03-11T11:00:00.000Z",
            summary: {
              finished: 0,
              inProgress: 1,
              pending: 0,
            },
          },
        })
      }

      if (url.includes("/v1/runs/run-7")) {
        return Response.json({
          run: {
            id: "run-7",
            workflowId: "issue-to-pr",
            status: "waiting-approval",
            startedAt: "2026-03-11T10:00:00.000Z",
            summary: {
              finished: 0,
              inProgress: 0,
              pending: 1,
            },
          },
        })
      }

      return new Response(null, { status: 500 })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs/run-7/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: {
            continue: true,
          },
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(capturedBodies).toHaveLength(1)
    expect(capturedBodies[0]).toMatchObject({
      input: {
        continue: true,
      },
      workflowPath: expect.stringContaining(`/${workspaceId}/.smithers/workflows/issue-to-pr/workflow.ts`),
    })
  })

  it("persists run events in the background after start-run without SSE clients", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    writeWorkflowFile(workspaceId, "issue-to-pr", "tsx")
    let eventStreamRequestCount = 0

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.includes("/v1/runs/run-bg/events") && method === "GET") {
        eventStreamRequestCount += 1
        return createSmithersSseResponse([
          'event: smithers\ndata: {"seq":1,"runId":"run-bg","type":"approval.pending","nodeId":"deploy","message":"Awaiting approval"}',
          'event: smithers\ndata: {"seq":2,"runId":"run-bg","type":"run.finished","message":"Done"}',
        ])
      }

      if (url.endsWith("/v1/runs") && method === "POST") {
        return Response.json({
          run: {
            id: "run-bg",
            workflowId: "issue-to-pr",
            status: "running",
            startedAt: "2026-03-11T11:00:00.000Z",
            summary: {
              finished: 0,
              inProgress: 1,
              pending: 0,
            },
          },
        })
      }

      return new Response(null, { status: 404 })
    }) as typeof fetch

    const startResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: {},
        }),
      })
    )

    expect(startResponse.status).toBe(201)
    const events = await waitForRunEvents(
      app,
      workspaceId,
      "run-bg",
      (runEvents) => runEvents.some((event) => event.seq === 2)
    )

    expect(eventStreamRequestCount).toBeGreaterThan(0)
    expect(events).toMatchObject([
      {
        seq: 1,
        runId: "run-bg",
        type: "approval.pending",
        nodeId: "deploy",
        message: "Awaiting approval",
        rawPayload: {
          seq: 1,
          runId: "run-bg",
          type: "approval.pending",
          nodeId: "deploy",
          message: "Awaiting approval",
        },
      },
      {
        seq: 2,
        runId: "run-bg",
        type: "run.finished",
        message: "Done",
        rawPayload: {
          seq: 2,
          runId: "run-bg",
          type: "run.finished",
          message: "Done",
        },
      },
    ])
  })

  it("forwards afterSeq to Smithers event stream requests", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    let capturedStreamUrl = ""

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.includes("/v1/runs/run-stream/events") && method === "GET") {
        capturedStreamUrl = url
        return createSmithersSseResponse([
          'event: smithers\ndata: {"seq":8,"runId":"run-stream","type":"smithers.event","message":"event"}',
        ])
      }

      return new Response(null, { status: 404 })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/runs/run-stream/events/stream?afterSeq=7`,
        {
          method: "GET",
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("event: smithers")
    expect(capturedStreamUrl).toContain("/v1/runs/run-stream/events")
    expect(capturedStreamUrl).toContain("afterSeq=7")
  })

  it("surfaces nested Smithers error messages instead of object coercion", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    writeWorkflowFile(workspaceId, "issue-to-pr", "tsx")

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/v1/runs") && method === "POST") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Workflow failed validation",
            },
          }),
          {
            status: 422,
            headers: { "content-type": "application/json" },
          }
        )
      }

      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: {},
        }),
      })
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: "Workflow failed validation",
    })
  })

  it("repairs legacy default templates before starting a run", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    writeLegacyWorkflowTemplate(workspaceId, "issue-to-pr")

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/v1/runs") && method === "POST") {
        return Response.json({
          run: {
            id: "run-repair-1",
            workflowId: "issue-to-pr",
            workflowName: "issue-to-pr",
            status: "running",
            startedAt: "2026-03-11T11:00:00.000Z",
            summary: {
              finished: 0,
              inProgress: 1,
              pending: 0,
            },
          },
        })
      }

      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: {},
        }),
      })
    )

    expect(response.status).toBe(201)

    const repairedSource = readFileSync(
      path.join(
        resolveTestWorkspacePath(workspaceId),
        ".smithers",
        "workflows",
        "issue-to-pr",
        "workflow.tsx"
      ),
      "utf8"
    )
    expect(repairedSource).toContain("createSmithers")
    expect(repairedSource).toContain("output={outputs.plan}")
  })
})
