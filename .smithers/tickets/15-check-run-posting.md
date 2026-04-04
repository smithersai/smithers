# Post Workflow Results as GitHub Check Runs

**Repo:** plue (JJHub Go backend)
**Feature:** Workflows + GitHub Integration
**Priority:** P0 — visible output on GitHub

## Description

When a workflow completes, post its results as a GitHub Check Run on the relevant commit. This includes the summary, conclusion, and line-level annotations.

## Acceptance Criteria

- [ ] On workflow completion, calls `POST /repos/{owner}/{repo}/check-runs` with:
  - `name`: `smithers / <workflow-name>`
  - `head_sha`: the commit SHA the workflow ran against
  - `status`: `completed`
  - `conclusion`: `success`, `failure`, or `neutral`
  - `output.title`: summary title
  - `output.summary`: Markdown summary
  - `output.annotations[]`: line-level annotations (max 50 per call, batched)
- [ ] Annotations include: file path, line numbers, level (notice/warning/failure), message
- [ ] Check run is visible on the GitHub PR's Checks tab
- [ ] Annotations appear inline on the GitHub diff view
- [ ] In-progress workflows post check run with `status: in_progress`

## E2E Test

```
1. Submit a stack, trigger AI review workflow
2. Workflow completes → check run posted on GitHub
3. GitHub PR shows check run with ✅ or ❌
4. Annotations visible on the diff
5. smithers run view <id> → includes check_run_id and check_run_url
```

## Reference

- Checks API: specs/reference-github-webhooks.md §4
- Policy layer: design doc §6
