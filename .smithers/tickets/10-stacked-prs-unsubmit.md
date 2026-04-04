# Stack Unsubmit — Close PRs and Clean Up

**Repo:** plue (JJHub Go backend)
**Feature:** Stacked PRs
**Priority:** P1

## Description

Implement `smithers stack unsubmit` which closes all GitHub PRs in the stack and deletes remote branches.

## Acceptance Criteria

- [ ] Closes all open GitHub PRs associated with the stack
- [ ] Deletes all `smithers/<change-id>` branches on the remote
- [ ] Removes stack mapping from backend DB
- [ ] Does NOT touch local jj changes
- [ ] Works even if some PRs are already closed/merged

## E2E Test

```
1. Submit stack of 2 PRs
2. smithers stack unsubmit → both PRs closed, branches deleted
3. smithers stack status → "no active stack"
4. Local jj changes still intact
```
