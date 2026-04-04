# Workflow Execution in Firecracker Sandboxes

**Repo:** plue (JJHub Go backend)
**Feature:** Workflows
**Priority:** P0

## Description

When a workflow run is created, the scheduler allocates a Firecracker sandbox, clones the repo at the target changeset, and executes the Smithers workflow inside it.

## Acceptance Criteria

- [ ] Workflow scheduler picks up queued runs
- [ ] Allocates Firecracker VM via existing `internal/sandbox/scheduler.go`
- [ ] VM created with: repo cloned at target changeset, jj + git + Node.js/Bun installed
- [ ] Smithers orchestrator installed in sandbox, executes the workflow `.tsx` file
- [ ] Resource limits: 2 vCPU, 4GB RAM, 10GB disk (configurable)
- [ ] Timeout: 10 minutes default, max 30 minutes
- [ ] Run status updates: queued → running → success/failure
- [ ] Logs streamed to backend (accessible via `smithers run logs`)
- [ ] VM auto-destroyed after workflow completes
- [ ] Network: only Smithers API Gateway + package registries allowed

## E2E Test

```
1. Trigger a simple workflow (echo "hello")
2. smithers run view <id> → status: success
3. smithers run logs <id> → shows "hello"
4. VM no longer exists after completion
```

## Reference

- Sandbox platform: `internal/sandbox/`
- Guest agent: `cmd/guest-agent/`
