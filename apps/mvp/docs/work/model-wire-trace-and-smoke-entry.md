---
title: Model wire trace measurements and smoke entry
status: done
area: model
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4747
---

Library catalog: model streaming (`@smthrs/model`). Request traces now use
the prepared body's byte length and the caller's Effect `Clock`. The smoke
example uses `import.meta.main`, preserving execution through paths with spaces
or symlinks and safe imports from files, eval and stdin.

Before the fix, Unicode trace sizes were `82` instead of `89` and `73` instead
of `74`; request timestamps ignored the injected clock. The original smoke
source failed both new path tests with empty output while its other six checks
passed. The fixed model suite passes `1,228` tests with `100%` statement,
branch, function and line coverage; nine existing provider checks are skipped.
The package typecheck passes.

Astra review found no remaining issues. The deterministic docs generators leave
their projections unchanged, and all `52` published-package tarball checks pass.

Two validation gaps are recorded on the issue without changing their behavior:
the tests/typecheck generate `examples/quickstart.d.vibe.ts`, which a subsequent
package lint reports with six declaration/style errors, and the docs flow entry
cannot load `typescript/unstable/ast` from the migration CLI. Source-tree lint
is validated separately before compiler output exists.
