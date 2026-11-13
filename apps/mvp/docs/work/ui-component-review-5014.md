---
title: UI component correctness and test contracts
status: done
area: ui
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5014
---

Correct patch metadata boundaries, completed test progress and collapse defaults for directories loaded later. Strengthen hint association, headless bundling, real diff fixtures and scroll geometry tests. Use the existing shared component library and its Bun test harness (library catalog: shared UI components).

Keep Draft validation behavior unchanged: the hint test proves accessible association, while the host controls whether submission is available.

Regression proof before the fixes: 12 failures across four suites, covering patch metadata, todo progress, late directories, geometry bounds and ambient signing/hooks configuration. The package declares Bun tests and VibeLang checks, with no lint or formatting target.

Validation: 218 scoped tests pass, both package VibeLang projects pass, and the package reference documentation check passes. The whole package suite also exercises the nested styleguide; the generated presentation bundle check fails on the unchanged parent revision as well. There is no package lint target. Codex Astra and Fable reviews found no actionable defects.
