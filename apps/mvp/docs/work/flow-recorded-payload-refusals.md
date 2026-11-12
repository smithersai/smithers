---
title: Recorded payload refusals and flow test inputs
status: done
area: sdk
owner: Codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/4632]
---

The flow package's tests and examples execute the engine. Both test and
typecheck targets depend on an engine source-only file group, shared through
a separate declaration module to avoid the engine library's flow dependency
cycle. The group also keys the engine's journal import. Keep ownership of source globs in the engine package.

A recorded plan with an uncanonical payload must name the offending node and
use `uncanonical_payload`. Diagnose failed plan identities through the
existing canonical serializer; keep successful plan identities and
non-recording action validation unchanged.

Validation: removing the engine input edge and restoring the previous
unexplained-plan refusal produces ten failing regression cases. The fix passes
the flow suite (1,077 tests and two existing expected failures), engine suite
(667 tests), and harness suite (2,699 tests, three existing skips), each at 100%
coverage. Flow, engine and harness typechecks pass. The target index is
regenerated and drift-checked; docs sync and all 52 package documentation
tarballs pass. The embedded realm SDK is regenerated and its parity check
passes.

Flow and engine lint pass, as does lint for the regenerated harness module.
Whole-package harness lint still reports an existing error in
`src/QuickJSWorkerd.ts` and three errors in the generated
`examples/quickstart.d.vibe.ts` declaration emitted by the package check.

Library catalog: "Hash, canonicalize JSON or derive a stable key"; reuse
`@smthrs/canonical`'s `canonicalize` for refusal diagnosis.
