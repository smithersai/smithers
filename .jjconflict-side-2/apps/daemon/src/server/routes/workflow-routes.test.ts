import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { handleWorkflowRoutes } from "@/server/routes/workflow-routes"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

function seedWorkspace(params: { runtimeMode?: "burns-managed" | "self-managed" } = {}) {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: resolveTestWorkspacePath(workspaceId),
    sourceType: "create",
    runtimeMode: params.runtimeMode ?? "burns-managed",
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

const directCtxInputSource = `import { createSmithers } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  echo: z.object({
    summary: z.string(),
    echoedInput: z.string(),
  }),
})

export default smithers((ctx) => (
  <Workflow name="echo">
    <Task id="echo" output={outputs.echo}>
      {{
        summary: "Echoed the workflow input.",
        echoedInput: JSON.stringify(ctx.input ?? null),
      }}
    </Task>
  </Workflow>
))
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

  it("saves a selected workflow file to disk", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const workflowDirectoryPath = path.join(
      resolveTestWorkspacePath(workspaceId),
      ".smithers",
      "workflows",
      "custom-flow"
    )
    const filePath = path.join(workflowDirectoryPath, "notes.md")

    mkdirSync(workflowDirectoryPath, { recursive: true })
    writeFileSync(path.join(workflowDirectoryPath, "workflow.tsx"), validWorkflowSource, "utf8")
    writeFileSync(filePath, "before", "utf8")

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/files/content?path=notes.md`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "# Updated" }),
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "custom-flow",
      path: "notes.md",
      source: "# Updated",
    })
    expect(readFileSync(filePath, "utf8")).toBe("# Updated")
  })

  it("discovers self-managed workflows outside the Burns workflow folder", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace({ runtimeMode: "self-managed" })
    const workflowDirectoryPath = path.join(
      resolveTestWorkspacePath(workspaceId),
      "smithers",
      "review"
    )

    mkdirSync(workflowDirectoryPath, { recursive: true })
    writeFileSync(path.join(workflowDirectoryPath, "workflow.tsx"), validWorkflowSource, "utf8")

    const listResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows`)
    )

    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toMatchObject([
      {
        id: "smithers-review",
        workspaceId,
        name: "valid-workflow",
        relativePath: "smithers/review/workflow.tsx",
      },
    ])

    const detailResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/smithers-review`)
    )

    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toMatchObject({
      id: "smithers-review",
      relativePath: "smithers/review/workflow.tsx",
      source: expect.stringContaining('name="valid-workflow"'),
    })
  })

  it("rejects workflow saves for self-managed workspaces", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace({ runtimeMode: "self-managed" })
    const workflowDirectoryPath = path.join(
      resolveTestWorkspacePath(workspaceId),
      "smithers",
      "review"
    )

    mkdirSync(workflowDirectoryPath, { recursive: true })
    writeFileSync(path.join(workflowDirectoryPath, "workflow.tsx"), validWorkflowSource, "utf8")

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/smithers-review`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: directCtxInputSource }),
      })
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Self-managed workflows are read-only"),
    })
  })

  it("saves workflow.ts edits back to workflow.ts instead of creating workflow.tsx", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const workflowDirectoryPath = path.join(
      resolveTestWorkspacePath(workspaceId),
      ".smithers",
      "workflows",
      "custom-flow"
    )
    const workflowTsPath = path.join(workflowDirectoryPath, "workflow.ts")

    mkdirSync(workflowDirectoryPath, { recursive: true })
    writeFileSync(workflowTsPath, validWorkflowSource, "utf8")

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/files/content?path=workflow.ts`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: directCtxInputSource }),
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "custom-flow",
      path: "workflow.ts",
    })
    expect(readFileSync(workflowTsPath, "utf8")).toContain('name="echo"')
  })

  it("rejects workflow file saves that escape the workflow directory", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const workflowDirectoryPath = path.join(
      resolveTestWorkspacePath(workspaceId),
      ".smithers",
      "workflows",
      "custom-flow"
    )

    mkdirSync(workflowDirectoryPath, { recursive: true })
    writeFileSync(path.join(workflowDirectoryPath, "workflow.tsx"), validWorkflowSource, "utf8")

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/files/content?path=../escape.ts`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "nope" }),
        }
      )
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("escapes workflow directory"),
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

  it("returns JSON object guidance when a workflow reads ctx.input directly", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/echo-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: directCtxInputSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/echo-flow/launch-fields`)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "echo-flow",
      mode: "fallback",
      entryTaskId: "echo",
      fields: [],
      message: "Enter run input as JSON.",
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

  it("provides a workflow path on local requests", async () => {
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
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/path`, {
        method: "POST",
      }),
      `/api/workspaces/${workspaceId}/workflows/custom-flow/path`
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({
      path: expect.stringContaining("custom-flow"),
    })
  })

  it("blocks workflow path from non-localhost requests", async () => {
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
      new Request(`http://example.com/api/workspaces/${workspaceId}/workflows/custom-flow/path`, {
        method: "POST",
      }),
      `/api/workspaces/${workspaceId}/workflows/custom-flow/path`,
      {}
    )

    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({
      error: "Workflow path actions are only available on local daemon URLs.",
      details: null,
    })
  })
})
