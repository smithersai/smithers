# Stack Sync — Rebase and Update

**Repo:** plue (JJHub Go backend)
**Feature:** Stacked PRs
**Priority:** P1

## Description

Implement `smithers stack sync` which fetches latest from GitHub, detects merged PRs, rebases the local stack, and force-pushes updated branches.

## Acceptance Criteria

- [ ] Runs `jj git fetch` to pull latest
- [ ] Detects if any stack PRs were merged on GitHub
- [ ] Removes merged changes from the local stack
- [ ] Rebases remaining changes onto updated target
- [ ] Force-pushes updated branches for remaining PRs
- [ ] Updates stack tables on remaining PRs

## E2E Test

```
1. Submit stack of 3 PRs
2. Merge PR #1 directly on GitHub (not via smithers)
3. smithers stack sync → detects merge, rebases remaining 2
4. smithers stack status → shows 2 PRs with updated base
```
