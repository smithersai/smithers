# Default Workflow: CI Failure Explainer

**Repo:** smithers (workflow orchestrator)
**Feature:** Default Workflows
**Priority:** P1

## Description

Create a workflow that triggers when a CI check fails, parses the logs, identifies the root cause, and posts a helpful comment on the PR.

## Acceptance Criteria

- [ ] Workflow file: `.smithers/workflows/ci-failure-explainer.tsx`
- [ ] Triggers: `check_run.completed` (with conclusion=failure)
- [ ] Reads check run output/logs
- [ ] Analyzes failure: identifies root cause, relevant code, and potential fix
- [ ] Posts a PR comment with:
  - What failed and why
  - The relevant code/config that caused it
  - Suggested fix
- [ ] Does not trigger on its own check runs (prevent loops)

## E2E Test

```
1. Submit PR with a failing test
2. CI check fails
3. CI failure explainer triggers
4. Comment posted on PR explaining the test failure and suggesting fix
```
