---
title: Build CLI regression coverage
status: done
area: build-cli
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5131]
---

Cover tagged version metadata, failed stamp reads and malformed stamp payloads.
Require the viem fixture's data edges and prove an idle watcher releases its
event-loop resources. Verify the stamp-specific coverage floor independently
of the global coverage floors. The UTF-8 PAX fix and its independent tar-reader
regression matrix landed in `1ef439d872f9`.

The viem fixture declares only data dependencies: its graph contains 40 data
edges and no gates or services. Its assertions and title reflect those inputs.

Validation passed in five focused test files (`51` cases), including the
existing PAX matrix. Package typecheck and lint, seven coverage-conformance
checks and all `52` published-package docs tarball checks passed.
`StampExec.ts` has `100%` coverage on every metric; removing its file-specific
floor makes the coverage-policy regression fail.

The full package run's unchanged service SIGINT driver fails to load
`StepTrace.vibe` without the VibeLang preload. The failure also reproduces on
the unmodified base; the reproduction is recorded on the linked issue.
