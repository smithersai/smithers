# Feature Flag All Non-MVP Routes

**Repo:** plue (JJHub Go backend)
**Feature:** Feature Flags
**Priority:** P0 — security, prevents access to unreleased features

## Description

Add new feature flags for every MVP feature and gate all non-MVP routes behind their respective flags. Non-MVP routes return 403 when their flag is off.

## Acceptance Criteria

- [ ] New flags added to `FeatureFlagsConfig` in `internal/config/config.go`:
  - `stacked_prs` (true), `workflows` (true), `sandboxes` (true), `auto_push` (true)
  - `issues` (false), `search` (false), `workspaces` (false), `agents` (false)
  - `web_dashboard` (false), `orgs` (false), `protected_bookmarks` (false)
  - `notifications` (false), `wiki` (false), `labels` (false), `releases` (false)
  - `secrets` (false), `webhooks_user` (false), `bot_commands` (false)
  - `draft_prs` (false), `reviewers` (false), `multi_auth` (false), `private_repos` (false)
- [ ] Every route family gated with middleware check
- [ ] `/api/*/issues/*` → 403 when `issues` is false
- [ ] `/api/search/*` → 403 when `search` is false
- [ ] `/api/*/wiki/*` → 403 when `wiki` is false
- [ ] (etc for all families listed in engineering doc §2)
- [ ] `GET /api/feature-flags` returns updated flag list
- [ ] CLI hides commands for disabled features

## E2E Test

```
1. GET /api/repos/owner/repo/issues → 403 "feature not available"
2. GET /api/search/repos?q=test → 403
3. GET /api/repos/owner/repo/landing-requests → 200 (enabled)
4. GET /api/feature-flags → all flags returned with correct defaults
```

## Reference

- Current flags: `internal/config/config.go` (10 existing flags)
- Flag handler: `internal/routes/flags.go`
