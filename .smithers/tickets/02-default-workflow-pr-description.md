# Default Workflow: PR Description Generator

**Repo:** smithers (workflow orchestrator)
**Feature:** Default Workflows
**Priority:** P1

## Description

Create a workflow that auto-generates structured PR descriptions from the diff on PR creation.

## Acceptance Criteria

- [ ] Workflow file: `.smithers/workflows/pr-description.tsx`
- [ ] Triggers: `pull_request.opened`, `stack_submit`
- [ ] Reads diff, generates: summary, what changed, why (inferred from commit messages + code)
- [ ] Injects description below the stack table (after `<!-- smithers:stack:end -->` marker)
- [ ] Does not overwrite user-written descriptions (only generates if body is empty or minimal)
- [ ] Posts as PR comment if description already exists

## E2E Test

```
1. Submit a stack with empty PR descriptions
2. Workflow triggers, generates descriptions
3. PR body on GitHub updated with structured description
4. Re-submit same stack → descriptions not overwritten
```
