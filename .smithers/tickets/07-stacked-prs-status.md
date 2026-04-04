# Stack Status — Show Stack with GitHub State

**Repo:** plue (JJHub Go backend)
**Feature:** Stacked PRs
**Priority:** P0

## Description

Implement `smithers stack status` which shows the current stack with GitHub PR status, CI checks, and review state.

## Acceptance Criteria

- [ ] `smithers stack status` reads local jj stack and matches to stored stack/PR mapping
- [ ] For each change: shows change_id, PR number, PR URL, review status, CI status
- [ ] Review status: pending, approved, changes_requested
- [ ] CI status: pending, passing, failing (aggregated from check runs)
- [ ] Human-readable output with status indicators (✅ 🟡 ❌ 🟢)
- [ ] `--json` output includes full details per design doc
- [ ] `--target` flag defaults to `main`

## E2E Test

```
1. Submit a stack of 2 PRs
2. smithers stack status → shows both with "pending" review, CI status
3. Simulate a review approval webhook on PR #1
4. smithers stack status → PR #1 shows "approved"
5. smithers stack status --json → valid JSON with all fields
```
