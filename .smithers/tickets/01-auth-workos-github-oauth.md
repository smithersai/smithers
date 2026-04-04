# Replace GitHub OAuth with WorkOS

**Repo:** plue (JJHub Go backend)
**Feature:** Authentication
**Priority:** P0 — blocks everything

## Description

Replace the existing custom GitHub OAuth flow in `internal/auth/` and `internal/routes/auth.go` with WorkOS SDK. WorkOS handles the GitHub OAuth consent screen, token exchange, and session management.

## Acceptance Criteria

- [ ] WorkOS Go SDK integrated (`github.com/workos/workos-go`)
- [ ] `GET /auth/workos/authorize` redirects to WorkOS-hosted GitHub OAuth
- [ ] `GET /auth/workos/callback` exchanges WorkOS code for session, issues Smithers JWT
- [ ] JWT stored in `~/.config/smithers/auth.json` by CLI
- [ ] Existing key-based auth (`internal/auth/key_auth.go`) removed or gated
- [ ] Linear OAuth removed or gated behind `integrations` feature flag
- [ ] Old GitHub OAuth routes removed

## E2E Test

```
1. smithers auth login → opens browser → completes OAuth → token stored locally
2. smithers auth status → shows username, email, expiry
3. smithers auth logout → token deleted
4. smithers auth status → shows "not logged in"
5. API call without token → 401
```

## Reference Code

- Current auth: `internal/routes/auth.go`, `internal/auth/`
- WorkOS Go SDK: https://github.com/workos/workos-go
