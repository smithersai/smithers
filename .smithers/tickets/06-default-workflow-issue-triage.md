# Default Workflow: Issue Triage

**Repo:** smithers (workflow orchestrator)
**Feature:** Default Workflows
**Priority:** P2

## Description

Create a workflow that triggers on issue creation, reviews the issue for quality and relevance, auto-labels it, and auto-closes duplicates or spam.

## Acceptance Criteria

- [ ] Workflow file: `.smithers/workflows/issue-triage.tsx`
- [ ] Triggers: `issues.opened`
- [ ] Analyzes issue: is it actionable? duplicate? spam? feature request? bug?
- [ ] Auto-labels: bug, feature, question, duplicate, needs-info
- [ ] If duplicate: posts comment linking original, closes issue
- [ ] If insufficient info: posts comment requesting reproduction steps
- [ ] If spam/irrelevant: closes with explanation

## E2E Test

```
1. Create issue with title "bug: crash on login"
2. Workflow triggers, labels as "bug"
3. Create duplicate issue → labeled "duplicate", closed with link to original
4. Create vague issue "it doesn't work" → comment requesting more info
```
