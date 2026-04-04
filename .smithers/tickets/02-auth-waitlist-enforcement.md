# Enforce Waitlist/Whitelist on Auth

**Repo:** plue (JJHub Go backend)
**Feature:** Authentication
**Priority:** P0 — blocks onboarding

## Description

After WorkOS auth succeeds, check the user's GitHub identity against the existing `alpha_whitelist_entries` table. If not whitelisted, check `alpha_waitlist_entries`. If not on either, create a waitlist entry with `status: pending`. Return appropriate errors.

## Acceptance Criteria

- [ ] Auth flow checks `alpha_whitelist_entries` after WorkOS callback
- [ ] Whitelisted user → JWT issued, login succeeds
- [ ] Waitlisted user with `status: approved` → promoted to whitelist, JWT issued
- [ ] Waitlisted user with `status: pending` → 403 `NOT_ON_WAITLIST`
- [ ] Unknown user → new waitlist entry created, 403 `NOT_ON_WAITLIST`
- [ ] Waitlist entries store GitHub username, email, avatar URL

## E2E Test

```
1. User NOT on whitelist → smithers auth login → 403 "Your account is not yet approved"
2. Admin adds user to whitelist via DB/API
3. User → smithers auth login → success
```

## Reference Code

- Existing alpha access: `internal/services/alpha_access.go`
- Auth service: `internal/services/auth.go`
