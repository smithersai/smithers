---
title: Build target paths and review record recovery
status: done
area: build
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5052
---

Correct TypeDoc input and output paths for a package working directory, persist
review records durably, keep watch sessions running until exit or interruption,
and inject filesystem faults through the existing Effect service in generator
rollback tests. Use the library catalog's `@smthrs/targets` target declarations
and the package's `PublicationFileSystem` service; no new library is required.

Validation:
- Package typecheck and lint pass; all 198 targeted tests in seven files pass.
- The regression run against the original implementation failed 13 assertions.
- The full package run has 3,385 passes, six failures and seven skips. All six
  failures reproduce on the unmodified base: unavailable sandbox tooling,
  permission checks running as root, and the CLI's missing
  `typescript/unstable/ast` import.
- Affected site projections regenerate with no drift, and all 52 published
  package tarball documentation checks pass.
- Standard `pnpm docs:sync` and `pnpm docs:check` fail on the unmodified base
  at that same CLI import. The supplemental API reference suite has 29 passes
  and one failure from an unchanged flows quickstart release pin.
