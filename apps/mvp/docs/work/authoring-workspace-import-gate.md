---
title: Authoring workspace import validation
status: done
area: evals
owner: authoring maintenance
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5411]
---

The authoring dataset gate rejects workspace imports whose selected export
target does not exist, packages with no legacy entry point, and missing or
private modules referenced by TypeScript import types.

The fix checks actual module files, resolves export conditions and legacy entry
points, and sends import types through the same gate. Regression cases also
cover invalid export-array fallbacks, literal wildcard captures, and runtime
default imports combined with named type imports.

Validation: the original validator fails four new tests; the fixed suite passes
all 18 tests under Node and Bun. The committed dataset's ten rows, package
typecheck, and TypeScript ESLint checks pass. Independent review found no
remaining blockers.
