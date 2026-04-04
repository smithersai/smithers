# GitHub App Webhook Receiver

**Repo:** plue (JJHub Go backend)
**Feature:** GitHub App Integration
**Priority:** P0 — blocks all GitHub integration

## Description

Register a GitHub App and implement the webhook receiver endpoint. GitHub sends events to our server; we validate the signature, parse the event, and enqueue it for processing.

## Acceptance Criteria

- [ ] GitHub App registered with correct permissions (contents:write, pull_requests:write, checks:write, metadata:read)
- [ ] Webhook secret stored in K8s secrets / env var
- [ ] `POST /webhooks/github` endpoint exists
- [ ] Validates `X-Hub-Signature-256` using HMAC-SHA256
- [ ] Parses `X-GitHub-Event` header to determine event type
- [ ] Responds 200 immediately (within 10 seconds)
- [ ] Enqueues event in PostgreSQL job queue for async processing
- [ ] Handles: `push`, `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `installation`, `installation_repositories`
- [ ] Stores installation ID ↔ repo mapping on `installation.created`
- [ ] Cleans up on `installation.deleted`

## E2E Test

```
1. Send a mock push webhook with valid signature → 200 OK
2. Send a mock webhook with invalid signature → 401
3. Send installation.created webhook → installation stored in DB
4. Send installation.deleted webhook → installation removed
5. Send push webhook → event appears in job queue
```

## Reference Code

- Existing webhook infra: `internal/webhook/`, `internal/webhooks/`
- GitHub webhook docs: specs/reference-github-webhooks.md
