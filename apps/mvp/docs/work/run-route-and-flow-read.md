---
title: Run navigation and flow-list failure recovery
status: done
area: runs
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5285
---

# Run navigation and flow-list failure recovery

Switching between the global and repository URLs for the same run must preserve the destination's page. The departing route closes the run only when the destination is outside both run routes.

The Run card must show loading and flow-list refusals before considering an empty result. Retry repeats the initial read for the same repository. A successful empty list hides the card.

Uses the existing TanStack Router lifecycle, Runs actions and store, and the library catalog's `@smthrs/ui` `LoadingBar` and `Button`.

Regression coverage: `tests/RunPage.loading.test.ts` exercises both URL directions over the real engine and collections; `tests/RepoFlowsView.test.ts` injects unavailable and rate-limited flow reads and exercises Retry through the real actions and form.

## Validation

Five regression cases fail on the previous implementation and pass with the fix. All 50 targeted tests and the changed production sources' lint pass. All four app typecheck projects and 26 deployment helper tests pass. The full app suite ran in six shards; existing suite and lint failures were compared against the baseline.
