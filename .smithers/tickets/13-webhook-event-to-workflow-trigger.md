# GitHub Event → Workflow Trigger Pipeline

**Repo:** plue (JJHub Go backend)
**Feature:** Workflows
**Priority:** P0 — connects GitHub events to workflow execution

## Description

When a GitHub webhook event is received and enqueued (ticket #04), the worker must resolve it to connected repos, read `.smithers/workflows/` from JJHub, match triggers, and create workflow runs.

## Acceptance Criteria

- [ ] Worker dequeues GitHub events from job queue
- [ ] Resolves event to connected repo via installation mapping
- [ ] Reads `.smithers/workflows/*.tsx` from the repo's latest JJHub state
- [ ] Parses workflow `on:` triggers (push, pull_request.opened, pull_request.synchronize, etc.)
- [ ] For each matching workflow, creates a workflow run record
- [ ] Dispatches run to workflow scheduler (which allocates a Firecracker sandbox)
- [ ] Handles `stack_submit` as a synthetic event triggered by `smithers stack submit`
- [ ] `schedule` triggers handled via cron job checker
- [ ] `manual` triggers handled via `smithers workflow run <name>`

## E2E Test

```
1. Connect repo with a workflow that triggers on pull_request.opened
2. Send mock pull_request.opened webhook
3. Workflow run created in DB with status "queued"
4. smithers run list → shows the triggered run
```

## Reference

- Workflow sync: `internal/services/workflow_sync.go`
- Design doc §5: Workflow Trigger API
