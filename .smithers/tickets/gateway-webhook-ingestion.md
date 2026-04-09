# Gateway webhook ingestion and GitHub App identity

## Problem

The smithers Gateway cannot function as a GitHub bot because:

### 1. No webhook ingestion endpoint

Gateway's HTTP server only serves `/health`. No `POST /webhooks/:source`
endpoint to receive GitHub (or other) webhooks. This is the single biggest
blocker for bot use cases.

### 2. No GitHub App identity

To post PR comments, create branches, or report check status, Gateway needs to
authenticate as a GitHub App with installation tokens. Currently has no GitHub
API client or App private key handling.

### 3. No HTTP REST API

Gateway is WebSocket-only. No REST endpoints for `runs.create`, `runs.list`,
etc. CI scripts and webhooks need HTTP POST, not WebSocket.

## Proposed solution

### Phase 1: Webhook receiver (~2-3 days)
- Add `POST /webhooks/:source` to Gateway HTTP server
- Verify webhook signatures (HMAC-SHA256 for GitHub)
- Map incoming webhooks to `signals.send` or `runs.create` based on config
- Add `@mention` parsing for `issue_comment` payloads

### Phase 2: HTTP REST API (~1-2 days)
- Expose all RPC methods via `POST /rpc` with JSON body
- Or mirror the Server's REST routes (`/v1/runs`, etc.)

### Phase 3: GitHub App identity (~3-5 days)
- Accept App ID + private key in gateway config
- JWT generation for app auth, installation token exchange
- Expose token provider that workflows can consume
- Thin Octokit wrapper for PR comments, check runs, branch creation

## Severity

**HIGH** — Required for ClaudeBot/OpenClaw feature parity.
