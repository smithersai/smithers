# Default Workflow: AI Code Review

**Repo:** smithers (workflow orchestrator)
**Feature:** Default Workflows
**Priority:** P0 — the hero workflow

## Description

Create a pre-built AI code review workflow that triggers on `pull_request.opened` and `pull_request.synchronize`. Reads the diff, reviews each file, and posts findings as GitHub Check Run annotations.

## Acceptance Criteria

- [ ] Workflow file: `.smithers/workflows/ai-review.tsx`
- [ ] Triggers: `pull_request.opened`, `pull_request.synchronize`, `stack_submit`
- [ ] Reads the diff for the PR (via GitHub API through policy proxy)
- [ ] Reviews each changed file for: bugs, security issues, style, performance
- [ ] Output: structured review with file path, line numbers, severity, message
- [ ] Results posted as Check Run with line-level annotations
- [ ] Conclusion: `success` (no issues), `neutral` (suggestions), `failure` (blocking)
- [ ] Completes within 2 minutes for typical PRs (<500 lines)

## E2E Test

```
1. Submit a stack with a PR that has an obvious bug
2. AI review workflow triggers automatically
3. Check run appears on GitHub PR
4. Annotation visible on the diff pointing to the bug
5. smithers run logs <id> → shows review reasoning
```
