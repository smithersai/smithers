# Rate Limiting — Per-Repo and Per-User

**Repo:** plue (JJHub Go backend)
**Feature:** Security
**Priority:** P1

## Description

Implement server-side rate limiting to prevent abuse and control costs.

## Acceptance Criteria

- [ ] Per-repo limits enforced:
  - Stack submits: 30/hour
  - Workflow runs: 60/hour
  - Sandbox hours: 10/day
  - API requests: 1,000/hour
- [ ] Per-user limits enforced:
  - Connected repos: 10 total
  - Concurrent workflow runs: 5
  - Concurrent sandboxes: 3
- [ ] Returns 429 Too Many Requests when exceeded
- [ ] Response includes `Retry-After` header
- [ ] GitHub API budget tracked per installation (5,000 req/hour)
- [ ] `smithers repo status` shows remaining rate limit budget

## E2E Test

```
1. Submit stack 31 times in an hour → 429 on attempt 31
2. Trigger 61 workflow runs in an hour → 429 on attempt 61
3. Connect 11 repos → error on attempt 11
```
