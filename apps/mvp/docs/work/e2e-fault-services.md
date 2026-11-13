---
title: E2E fault services and shared feed ownership
status: done
area: testing
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5250
---

The first-paint and stack upgrade proofs use injected development-host services rather than browser request
interception (TEST-2, TEST-7). The host serves both browser builds unchanged. Stack refusals come from the real
handler after its injected session service reports a Guest; held shapes pass authorization before their transport
waits. A cancellable clock event keeps the held request alive in workerd. The library catalog entry is `@smthrs/effect-electric`'s `ShapeProxy.Upstream`.

The factory-feed proof acquires a `ResourceLocks` lease before it owns cleanup. Failed contenders leave the owner's
documents and nonce untouched. Docs search declares the separate `docsSite` prerequisite.

Validation: the 288 focused service, target and package-rule checks pass against real Postgres and Electric.
The fault host's 18 regressions and the feed lease's two regressions each achieve 100% coverage. Shape-proxy and
Worker-startup checks pass; the docs prerequisite skips both local browser targets before navigation.
The original specs fail the two new target/interception guards, and restoring unconditional feed cleanup fails
the ownership regression. Replacing the clock-backed hold with a bare unresolved effect also fails its lifecycle test.

Package-wide checks retain baseline failures: the removed `@smthrs/agent/AgentAction` import blocks broader stack
tests and typechecking, and lint reports failures in unchanged files. Comparing the Worker typecheck with the
unmodified host wiring adds no diagnostics. The resource inventory also lacks `cold-search.spec.ts` (related to
[the cold-path test work](https://github.com/smithersai/smithers/issues/5247)). These checks are not reported as green.
The cross-build browser journey still requires a development server and the deployed build's files.
