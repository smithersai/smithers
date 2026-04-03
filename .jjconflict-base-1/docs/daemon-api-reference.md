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
  "service": "burns-daemon"
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
- `smithersManagedPerWorkspace`
- `smithersAuthMode`
- `hasSmithersAuthToken`
- `rootDirPolicy`
- `diagnosticsLogLevel`
- `diagnosticsPrettyLogs`

When `smithersManagedPerWorkspace` is `true`, Burns supervises one Smithers HTTP server per workspace and routes run/approval/event requests to the correct workspace-local instance.

Auth tokens are never returned in plaintext. The API only returns `hasSmithersAuthToken` to indicate whether a token is currently stored.

## `PUT /api/settings`

Updates persisted Burns defaults.

Request body must include the editable settings fields above. Optional auth-token controls:

- `smithersAuthToken`: set or replace the stored Smithers auth token
- `clearSmithersAuthToken`: clear the stored token without changing other fields

## `POST /api/settings/reset`

Resets persisted settings back to daemon defaults.

This is non-destructive:

- workspace registry is preserved
- workspace files are preserved
- onboarding completion is preserved

## `POST /api/settings/factory-reset`

Clears Burns application state and returns the app to first-run onboarding.

Factory reset:

- removes all workspace records from Burns
- clears persisted settings
- clears onboarding completion
- preserves repo folders and existing `.smithers` data on disk

## `GET /api/onboarding-status`

Returns first-run onboarding state.

Response:

```json
{
  "completed": false
}
```

## `POST /api/onboarding-status/complete`

Marks first-run onboarding as completed.

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

When `workflowTemplateIds` is provided on a Burns-managed workspace, Burns adds only the selected template workflows and preserves any existing workflow files already present in the repo.

For new workspaces, daemon-managed Smithers mode starts a workspace-local Smithers server in the background.

## `POST /api/workspaces/discover-local-workflows`

Scans a local repository path for existing Burns workflows under `.smithers/workflows`.

Available only from loopback/local daemon URLs.

Request body:

```json
{
  "localPath": "/absolute/path/to/repo"
}
```

Response body:

```json
{
  "localPath": "/absolute/path/to/repo",
  "workflows": [
    {
      "id": "issue-to-pr",
      "name": "issue-to-pr",
      "relativePath": ".smithers/workflows/issue-to-pr/workflow.tsx"
    }
  ]
}
```

## `GET /api/workspaces/:workspaceId`

Returns one workspace by ID.

Returns `404` if workspace does not exist.

## `POST /api/workspaces/:workspaceId/open-folder`

Opens the workspace directory in the native file manager.

Available only from loopback/local daemon URLs.

Returns `204 No Content` on success.

## `POST /api/workspaces/:workspaceId/path`

Returns the absolute workspace directory path.

Available only from loopback/local daemon URLs.

## `GET /api/workspaces/:workspaceId/health`

Returns workspace status based on filesystem presence:

- `healthy`
- `disconnected`
- `unknown`

## `GET /api/workspaces/:workspaceId/server/status`

Returns workspace Smithers runtime status:

- `runtimeMode` (`burns-managed` or `self-managed`)
- `processState` (`starting`, `healthy`, `crashed`, `stopped`, `self-managed`, `disabled`)
- `lastHeartbeatAt`
- `restartCount`
- `crashCount`
- `port`
- `baseUrl`

## `POST /api/workspaces/:workspaceId/server/start`

Starts workspace Smithers runtime (managed mode) and returns server status payload.

## `POST /api/workspaces/:workspaceId/server/restart`

Restarts workspace Smithers runtime (managed mode) and returns server status payload.

## `POST /api/workspaces/:workspaceId/server/stop`

Stops workspace Smithers runtime (managed mode) and returns server status payload.

## Workflows

Workflows are stored on disk under:

```txt
<workspace>/.smithers/workflows/<workflow-id>/workflow.tsx
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

## `POST /api/workspaces/:workspaceId/workflows/:workflowId/open-folder`

Opens the workflow directory in the native file manager.

Available only from loopback/local daemon URLs.

Returns `204 No Content` on success.

## `POST /api/workspaces/:workspaceId/workflows/:workflowId/path`

Returns the absolute workflow directory path.

Available only from loopback/local daemon URLs.

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

## Runs

## `GET /api/workspaces/:workspaceId/runs`

Returns run list for workspace (Smithers-backed).

When daemon-managed mode is enabled, Burns ensures the workspace Smithers instance is running before handling this request.

## `POST /api/workspaces/:workspaceId/runs`

Starts a new run for the selected workflow.

Request body:

```json
{
  "workflowId": "issue-to-pr",
  "input": {}
}
```

## `GET /api/workspaces/:workspaceId/runs/:runId`

Returns one run by ID.

## `POST /api/workspaces/:workspaceId/runs/:runId/resume`

Resumes a run.

Request body:

```json
{
  "input": {}
}
```

## `POST /api/workspaces/:workspaceId/runs/:runId/cancel`

Cancels a run.

Request body:

```json
{
  "reason": "optional reason"
}
```

## `GET /api/workspaces/:workspaceId/runs/:runId/events`

Returns persisted run events from local SQLite.

Each event includes normalized fields (`seq`, `runId`, `type`, `timestamp`, optional `nodeId`/`message`) plus optional `rawPayload`, which is the original Smithers event payload when available.
For legacy mirrored events that predate `rawPayload` persistence, Burns attempts to hydrate `rawPayload` from the workspace Smithers database (`.smithers/state/smithers.db`) using `runId` + `seq`.

Optional query string:

- `afterSeq=<number>` to fetch incremental events

## `GET /api/workspaces/:workspaceId/runs/:runId/events/stream`

SSE proxy stream to Smithers events endpoint.

Response content type: `text/event-stream`.

Incoming `event: smithers` payloads are persisted to SQLite.
Burns also maintains a background ingestion stream per active run, so events continue to persist even if no web client is currently connected to this SSE endpoint.

## Approvals

## `GET /api/workspaces/:workspaceId/approvals`

Returns workspace approvals from local persistence.

## `POST /api/workspaces/:workspaceId/runs/:runId/nodes/:nodeId/approve`

Sends approval decision to Smithers, resumes the run through the standard resume flow, and persists local approval state.

Request body:

```json
{
  "decidedBy": "operator-name",
  "note": "optional note"
}
```

## `POST /api/workspaces/:workspaceId/runs/:runId/nodes/:nodeId/deny`

Sends denial decision to Smithers and persists local approval state.

Request body:

```json
{
  "decidedBy": "operator-name",
  "note": "optional note"
}
```

## Error behavior

Route handlers normalize thrown errors into JSON responses:

```json
{
  "error": "message"
}
```

Validation and business-rule failures generally return `400` or `409`. Missing resources return `404`.
