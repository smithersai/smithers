import { randomUUID } from "node:crypto"

import { describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { handleWorkflowRoutes } from "@/server/routes/workflow-routes"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

function seedWorkspace() {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: resolveTestWorkspacePath(workspaceId),
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  return workspaceId
}

const validWorkflowSource = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({ summary: z.string() }),
})

export default smithers(() => (
  <Workflow name="valid-workflow">
    <Sequence>
      <Task id="plan" output={outputs.plan}>
        {{ summary: "ready" }}
      </Task>
    </Sequence>
  </Workflow>
))
`

const invalidLegacySource = `import { Sequence } from "smithers-orchestrator"

export default smithers(() => (
  <Workflow name="legacy">
    <Task id="plan" output="plan">Legacy</Task>
  </Workflow>
))
`

const inferableLaunchFieldsSource = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  analysis: z.object({ summary: z.string() }),
  fix: z.object({ patch: z.string() }),
})

export default smithers((ctx) => (
  <Workflow name="code-review">
    <Sequence>
      <Task id="analyze" output={outputs.analysis}>
        {\`Review repository \${ctx.input.repo} and area \${ctx.input.focusArea ?? "general"}\`}
      </Task>
      <Task id="fix" output={outputs.fix}>
        {"Fix issues"}
      </Task>
    </Sequence>
  </Workflow>
))
`

const inferableFromPreludeSource = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({ summary: z.string() }),
})

export default smithers((ctx) => {
  const feature = ctx.input?.feature ?? ctx.input?.description ?? "fallback"

  return (
    <Workflow name="implement-feature">
      <Sequence>
        <Task id="plan" output={outputs.plan}>
          {\`Plan this feature: \${feature}\`}
        </Task>
      </Sequence>
    </Workflow>
  )
})
`

const inferableNullishChainSource = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  explain: z.object({ summary: z.string() }),
})

export default smithers((ctx) => {
  const question =
    ctx.input?.question ??
    ctx.input?.query ??
    ctx.input?.prompt ??
    "fallback"

  return (
    <Workflow name="explain">
      <Sequence>
        <Task id="analyze" output={outputs.explain}>
          {\`Question: \${question}\`}
        </Task>
      </Sequence>
    </Workflow>
  )
})
`

describe("workflow routes", () => {
  it("saves valid workflow source", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: "custom-flow",
      workspaceId,
      name: "custom-flow",
    })
  })

  it("rejects invalid legacy-style workflow source", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: invalidLegacySource }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("createSmithers"),
    })
  })

  it("streams authoring errors for generate/stream requests", async () => {
    const app = createApp()
    const missingWorkspaceId = `missing-${randomUUID()}`

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${missingWorkspaceId}/workflows/generate/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "streamed-workflow",
          agentId: "codex",
          prompt: "Create a workflow",
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")

    const body = await response.text()
    const events = body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Workspace not found"),
    })
  })

  it("infers launch fields from first task ctx.input references", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/inferred-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: inferableLaunchFieldsSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/inferred-flow/launch-fields`
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "inferred-flow",
      mode: "inferred",
      entryTaskId: "analyze",
      fields: [
        { key: "repo", label: "Repo", type: "string" },
        { key: "focusArea", label: "Focus Area", type: "string" },
      ],
    })
  })

  it("returns fallback mode when launch fields cannot be inferred", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/launch-fields`
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "custom-flow",
      mode: "fallback",
      entryTaskId: "plan",
      fields: [],
      message: "Unable to determine inputs automatically.",
    })
  })

  it("infers launch fields when ctx.input is referenced before first task", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/prelude-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: inferableFromPreludeSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/prelude-flow/launch-fields`
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "prelude-flow",
      mode: "inferred",
      entryTaskId: "plan",
      fields: [
        { key: "feature", label: "Feature", type: "string" },
      ],
    })
  })

  it("keeps only the first ctx.input key in nullish-coalescing chains", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/explain-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: inferableNullishChainSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/explain-flow/launch-fields`
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "explain-flow",
      mode: "inferred",
      entryTaskId: "analyze",
      fields: [{ key: "question", label: "Question", type: "string" }],
    })
  })

  it("opens a workflow folder path on localhost requests", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )
    expect(saveResponse.status).toBe(200)

    let openedPath = ""
    const response = await handleWorkflowRoutes(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/open-folder`,
        {
          method: "POST",
        }
      ),
      `/api/workspaces/${workspaceId}/workflows/custom-flow/open-folder`,
      { openWorkflowFolder: (directoryPath) => {
        openedPath = directoryPath
      } }
    )

    expect(response?.status).toBe(204)
    expect(openedPath).toBeTruthy()
  })

  it("provides a cd command for a workflow path on local requests", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )
    expect(saveResponse.status).toBe(200)

    const response = await handleWorkflowRoutes(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/cd-command`,
        {
          method: "POST",
        }
      ),
      `/api/workspaces/${workspaceId}/workflows/custom-flow/cd-command`
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({
      command: expect.stringContaining("custom-flow"),
    })
  })

  it("blocks workflow cd command from non-localhost requests", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )
    expect(saveResponse.status).toBe(200)

    const response = await handleWorkflowRoutes(
      new Request(`http://example.com/api/workspaces/${workspaceId}/workflows/custom-flow/cd-command`, {
        method: "POST",
      }),
      `/api/workspaces/${workspaceId}/workflows/custom-flow/cd-command`,
      {}
    )

    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "Workflow command actions are only available on local daemon URLs.",
      details: null,
    })
  })
})
