# Default Workflow: Lint CI Auto-Fix

**Repo:** smithers (workflow orchestrator)
**Feature:** Default Workflows
**Priority:** P1

## Description

Create a workflow that triggers when a lint check fails, reads the errors, generates a fix, and pushes it to the PR branch.

## Acceptance Criteria

- [ ] Workflow file: `.smithers/workflows/lint-autofix.tsx`
- [ ] Triggers: `check_run.completed` (with conclusion=failure, name matching lint patterns)
- [ ] Reads lint error output from the check run
- [ ] Generates fix for each lint error
- [ ] Commits and pushes fix to the PR branch (via `smithers/*` branch)
- [ ] If fix passes lint on re-check, done
- [ ] If can't fix, posts a comment explaining the cause and suggesting manual fix
- [ ] Only runs on `smithers/*` branches (not main)

## E2E Test

```
1. Submit PR with ESLint error (e.g., unused variable)
2. Lint check fails
3. Lint autofix workflow triggers
4. Fix committed to PR branch
5. Lint re-runs → passes
```
