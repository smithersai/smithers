---
title: Real TODO test machines and concurrent clone starts
status: done
area: testing
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5337
  - https://github.com/smithersai/smithers/issues/4832
---

TODO tests and the steer eval must run sandbox tools and commands on the same real checkout.
Clone test hosts must share initialization, start each execution once, and release startup permits after failure.

Uses the library catalog's `@smthrs/sandbox` tools and command jobs through the existing process-backed box, and
`@smthrs/platform-node`'s real durable host. No public API or production behavior changes.

Validation: the TODO, clone, branch-publish, real-runner and repository suites pass, as do the sandbox regressions,
the steer-eval checks and the app's typecheck. Full app lint retains the existing failures tracked in #4832.
