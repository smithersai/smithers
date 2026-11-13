---
title: External transcript fixture privacy
status: done
area: agent
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4812
---

Recorded external transcripts and independently mapped expected entries now use
neutral home-directory paths and local account labels. Fixture manifests describe
the substitutions, omit private receipt locations, and identify the removed
capture harness as historical provenance. Decoder behavior and historical
evidence archives are unchanged.

The existing recorded-capture suite checks transcript data, expected entries and
manifests for maintainer home paths, encoded home prefixes, local account labels
and private receipt paths. Removed-package commands are prohibited in manifests;
historical command payloads remain valid recorded evidence.

Validation:

- The new regression check fails for three original fixtures and passes for the
  two already neutral fixtures before the sanitization.
- All four changed data files are exactly the two intended literal
  substitutions: 195 home paths plus the account label. The 133-row/36-entry
  Claude capture and 109-row/34-entry Codex capture retain their structure.
- The full harness suite passes: 2,693 tests, three skipped, with 100% statements,
  branches, functions and lines.
- Package lint and direct source and test typechecks pass.
- The combined package check reports a stale generated realm bundle. The same
  failure reproduces on untouched `main` at `1edce13c3376`; the direct source and
  test typechecks also pass there. This fixture change does not regenerate or
  modify the realm bundle.
