---
title: Repository view state corrections
status: done
area: ui
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5390
---

Correct the repository design views without changing the public SDK:

- Documentation reserves every heading ID, including generated suffixes.
- Diff comments retain their old or new side through posting, pending reviews,
  links, conversation excerpts and reopening.
- Home evidence reads current issue edits and removes reopened issues.
- Agent model edits persist per repository and feed flow roles and run launch.

The views retain their existing local components and session overlays; no new
rendering library or runtime is introduced. See the UI and repository-view
entries in [the library catalog](../../../../docs/libraries.md).

Validation: 22 repository view, frame, Markdown and cast checks pass, and
all changed modules pass lint. Regression cases cover heading permutations,
real issue-store edits, both replacement sides, pending reviews, saved links,
resolve/reopen, model permissions, repository isolation and reload.

The standalone mock TypeScript project reports the same diagnostics as
unchanged `main`, including removed app imports and unavailable SDK
dependencies. This change adds no diagnostics.
