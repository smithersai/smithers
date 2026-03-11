# Daemon API Reference

Base URL: `http://localhost:7332`

All endpoints return JSON unless noted otherwise. CORS is enabled with `*`.

## Health and diagnostics

## `GET /api/health`

Health ping endpoint.

Response:

```json
{
  "ok": true,
  "service": "mr-burns-daemon"
}
```

## `GET /api/doctor`

Returns lightweight diagnostic checks.

Current implementation returns static passing checks.

## Settings and agents

## `GET /api/settings`

Returns daemon defaults:

- `workspaceRoot`
- `defaultAgent`
- `smithersBaseUrl`
- `allowNetwork`

## `GET /api/agents/clis`

Returns installed supported CLI agents detected via `which`.

Supported agent IDs:

- `claude-code`
- `codex`
- `gemini`
- `pi`

If a CLI is not installed, it is omitted from the response list.

## Workspaces

## `GET /api/workspaces`

Lists persisted workspaces from SQLite.

## `POST /api/workspaces`

Creates a workspace from one of three source types:

- `local`: attach existing local git repo
- `clone`: clone git repo URL into managed workspace root
- `create`: create a new repo with `git init`

Request body is validated by `createWorkspaceInputSchema`.

## `GET /api/workspaces/:workspaceId`

Returns one workspace by ID.

Returns `404` if workspace does not exist.

## `GET /api/workspaces/:workspaceId/health`

Returns workspace status based on filesystem presence:

- `healthy`
- `disconnected`
- `unknown`

## Workflows

Workflows are stored on disk under:

```txt
<workspace>/.mr-burns/workflows/<workflow-id>/workflow.tsx
```

## `GET /api/workspaces/:workspaceId/workflows`

Lists workflow summaries for a workspace by scanning workflow directories.

## `GET /api/workspaces/:workspaceId/workflows/:workflowId`

Returns workflow metadata plus source content.

## `PUT /api/workspaces/:workspaceId/workflows/:workflowId`

Creates or overwrites `workflow.tsx` with provided source.

Request body:

```json
{
  "source": "..."
}
```

## `DELETE /api/workspaces/:workspaceId/workflows/:workflowId`

Deletes the workflow directory recursively.

Returns `204 No Content` on success.

## `POST /api/workspaces/:workspaceId/workflows/generate`

Generates a new workflow file using a selected installed agent CLI.

Request body:

```json
{
  "name": "issue-to-pr",
  "agentId": "codex",
  "prompt": "Create a workflow that..."
}
```

## `POST /api/workspaces/:workspaceId/workflows/:workflowId/edit`

Edits an existing workflow file via selected installed agent CLI.

Request body:

```json
{
  "agentId": "codex",
  "prompt": "Add an approval gate before deploy..."
}
```

## Runs and approvals

## `GET /api/workspaces/:workspaceId/runs`

Returns run list for workspace.

Current implementation is mock-backed (`domain/workspaces/mock-data.ts`).

## `GET /api/workspaces/:workspaceId/approvals`

Returns approval list for workspace.

Current implementation is mock-backed (`domain/workspaces/mock-data.ts`).

## Error behavior

Route handlers normalize thrown errors into JSON responses:

```json
{
  "error": "message"
}
```

Validation and business-rule failures generally return `400` or `409`. Missing resources return `404`.
