---
title: Package runner collaborators
status: done
area: sdk
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5107
---

Use the real target declaration API, package index and process runner in the
changed-file selection tests. Inject publication failures through an Effect
host service while retaining real filesystem writes, replacement and cleanup.
The package already applies its no-mock import rule to every test file.
Catalog entries: `@smthrs/targets`, `@smthrs/build-cli`, `@smthrs/platform-node`.

The commit-gate output finding does not reproduce: the supervisor creates its
`RcMap` in the outer Effect context. A real commit and served gate report both
service streams and leave readiness files confined to the candidate tree.
Keep that integration regression without changing the runner runtime.

The native-declaration regression fails against the original metadata mock:
`Target.metadata` returns an opaque target handle with no `inputs`. The revised
suite uses validated declarations and a real `PackageIndex`.

Validation: all 67 focused tests in six suites pass, including the shrinking
legacy-inventory guard. Package typecheck and lint pass. The target index was
regenerated and its drift check passes. Independent review found no additional
issues.

The full package runs share exactly 280 failing tests on the unchanged base
and the fix. The fix run's only additional failure was the removed mocks'
stale inventory allowances; those allowances are now deleted and the guard
passes. The full package gate remains red on the base; no full-green claim is
made.
