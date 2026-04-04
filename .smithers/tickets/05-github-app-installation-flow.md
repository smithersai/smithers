# GitHub App Installation Flow

**Repo:** plue (JJHub Go backend)
**Feature:** GitHub App Integration
**Priority:** P0 — blocks repo connect

## Description

When a user runs `smithers repo connect`, the CLI must check if the Smithers Cloud GitHub App is installed on the target repo. If not, guide the user to install it and poll until detected.

## Acceptance Criteria

- [ ] `GET /api/repos/{owner}/{repo}/github-app-status` endpoint returns installation status
- [ ] CLI checks this endpoint during `repo connect`
- [ ] If not installed: prints install URL, polls every 2 seconds
- [ ] Backend detects new installations via `installation` and `installation_repositories` webhooks
- [ ] Maps installation ID to user account and repos
- [ ] `repo connect` succeeds once installation is detected
- [ ] Installation token generation: backend can create short-lived GitHub installation tokens

## E2E Test

```
1. smithers repo connect owner/repo (app not installed) → prints install URL, starts polling
2. Simulate installation webhook → backend stores installation
3. CLI poll detects installation → connect succeeds
4. smithers repo status → github_app_installed: true
```
