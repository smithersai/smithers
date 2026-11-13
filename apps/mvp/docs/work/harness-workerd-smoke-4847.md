---
title: Verify the worker started by the harness smoke
status: done
area: harness
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4847
---

Make the Wrangler smoke wait for its own ready URL, bound requests and response
bodies, and stop its process tree on completion, failure and POSIX termination.
Typecheck the worker through the package test project and document the separate
dependency installation and smoke commands. Match the package's actual WASM
import in the fixture's bundler rule.

Regression coverage uses real Wrangler processes and HTTP listeners for an
occupied port, a stalled response and signal cleanup. The package typecheck
membership test runs by default.

Validation: the compiler-membership and occupied-port regressions fail on the
original sources. The full harness suite passes 2,706 tests, including seven
real smoke checks, with 100% source coverage. Clean-tree lint, source and test
typechecks, the generated target index and the underlying package documentation
checks pass. Codex Astra and Fable reviews return LGTM.

The aggregate package check still stops at the existing stale realm-bundle
precheck. The documentation flow wrapper needs its native filesystem helper.
The VibeLang compiler also leaves a generated declaration in the example tree
that a subsequent lint rejects; the issue records its reproduction. No compiler
workaround or lint suppression is included.
