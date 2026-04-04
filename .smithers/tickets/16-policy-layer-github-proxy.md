# Smithers Policy Layer — GitHub API Proxy

**Repo:** plue (JJHub Go backend)
**Feature:** Security
**Priority:** P0 — sandboxes must never hold GitHub tokens

## Description

Implement the API gateway that sits between workflow sandboxes and GitHub. Sandboxes call the Smithers gateway; the gateway checks permissions and forwards to GitHub.

## Acceptance Criteria

- [ ] `POST /api/internal/github-proxy` endpoint accepts requests from sandboxes
- [ ] Authenticates sandbox via short-lived sandbox token (issued when VM starts)
- [ ] Resolves which workflow run the sandbox belongs to
- [ ] Checks the action against the policy table:
  - Built-in workflows: read contents, post check runs, post PR comments
  - Custom workflows: read contents, post check runs, post PR comments
  - Neither can: merge PRs, create/close PRs, delete branches, push to non-`smithers/*` branches
- [ ] If allowed: forwards request to GitHub API using installation token
- [ ] If denied: returns 403 with explanation
- [ ] Logs all proxied requests for audit

## E2E Test

```
1. Sandbox requests POST check run → allowed, forwarded to GitHub
2. Sandbox requests merge PR → 403 "not allowed for workflows"
3. Sandbox requests push to main → 403 "can only push to smithers/* branches"
4. Sandbox requests read file → allowed
```

## Reference

- Design doc §6: Policy Layer
