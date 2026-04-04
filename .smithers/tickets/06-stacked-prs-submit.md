# Stack Submit — Create Linked GitHub PRs

**Repo:** plue (JJHub Go backend)
**Feature:** Stacked PRs
**Priority:** P0 — core feature

## Description

Implement `smithers stack submit` which reads the local jj change stack and creates one GitHub PR per change, with base branches pointing to each other (Graphite-style stacking).

## Acceptance Criteria

- [ ] `smithers stack submit` reads jj change stack (all non-empty changes between `@` and `--target`)
- [ ] For each change (bottom-up): creates git branch `smithers/<change-id-short>`, pushes to GitHub
- [ ] Creates GitHub PR for each change via GitHub API:
  - Base branch = `smithers/<change-id-below>` (or `main` for bottom)
  - Title = first line of jj change description
  - Body = rest of description + stack table (see design doc §3)
- [ ] Stack table injected between `<!-- smithers:stack:start -->` and `<!-- smithers:stack:end -->` markers
- [ ] Stack ↔ PR mapping stored in backend (`stacks` + `stack_changes` tables)
- [ ] Idempotent: re-running updates existing PRs instead of creating duplicates
- [ ] Force-push blocked if remote branch has diverged since last submit
- [ ] `--target` flag defaults to `main`

## E2E Test

```
1. Create 3 jj changes in a stack
2. smithers stack submit → 3 PRs created on GitHub
3. Each PR has correct base branch (chained)
4. Each PR body contains stack table with all 3 PRs
5. Re-run smithers stack submit → PRs updated, not duplicated
6. smithers stack submit --json → returns stack_id, change_ids, pr_numbers
```

## Database

New tables: `stacks`, `stack_changes` (see engineering doc §7)
