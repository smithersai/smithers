# Default Workflow: Changelog Generator

**Repo:** smithers (workflow orchestrator)
**Feature:** Default Workflows
**Priority:** P2

## Description

Create a workflow that generates a changelog from commit history when a tag is created or on manual dispatch.

## Acceptance Criteria

- [ ] Workflow file: `.smithers/workflows/changelog.tsx`
- [ ] Triggers: `create` (ref_type=tag), `manual`
- [ ] Reads commit history since last tag
- [ ] Groups changes: features, fixes, breaking changes, other
- [ ] Generates human-readable changelog in Markdown
- [ ] Posts as GitHub Release body (via Releases API)
- [ ] Optionally updates CHANGELOG.md in the repo

## E2E Test

```
1. Tag a release (v1.0.0)
2. Workflow triggers, generates changelog
3. GitHub Release created with structured changelog body
```
