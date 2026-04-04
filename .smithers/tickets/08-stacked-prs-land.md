# Stack Land — Merge Approved PRs Bottom-Up

**Repo:** plue (JJHub Go backend)
**Feature:** Stacked PRs
**Priority:** P0

## Description

Implement `smithers stack land` which merges the bottom-most approved, CI-passing PR and rebases the rest.

## Acceptance Criteria

- [ ] `smithers stack land` identifies lowest approved + CI-passing change
- [ ] Merges its GitHub PR via GitHub merge API
- [ ] After merge: updates base branches of remaining PRs (rebase onto new main)
- [ ] Updates stack tables on remaining PRs
- [ ] Locally: runs `jj git fetch` + rebases local stack
- [ ] `--all` flag lands all consecutively approved changes
- [ ] `--change <id>` lands a specific change and everything below
- [ ] Refuses to land if CI is failing or review not approved

## E2E Test

```
1. Submit stack of 3 PRs, approve bottom 2
2. smithers stack land → merges PR #1
3. PR #2 base branch updated to main
4. smithers stack land --all → merges PR #2
5. PR #3 base branch updated to main
6. smithers stack status → only PR #3 remaining
```
