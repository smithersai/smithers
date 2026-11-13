---
title: Package manifest template licenses and generated-field cache safety
status: done
area: build
owner: none
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5044
  - ../../../../packages/smithers/build/targets/src/PackageJson.ts
---

Package manifest defaults must apply after template fields merge, so an omitted
package license inherits the template license. The merged license must satisfy
the existing supported-license schema.

Checks that consult generated-field host state cannot share cached verdicts.
Literal-only checks retain caching; generated-field checks retain offline drift
detection and run on each host.

Use the existing target and schema APIs; no new library or public API is needed.
Regression tests cover supported template licenses, package overrides, fallback,
invalid merged licenses, and cache admission for each generated-field combination.

The documented `fields.license` escape hatch still accepts unvalidated custom
values and retains precedence. Modeled package licenses still validate even
when raw fields override the rendered value.

Validation: the regression file had 16 expected failures against the parent,
covering template inheritance, merged validation, and generated-field cache
admission. All 87 manifest tests pass with the fix. The full target suite,
package typecheck, lint, docs sync, and docs check pass; the docs check includes
52 published package tarballs. Two independent reviews found no remaining issues.
