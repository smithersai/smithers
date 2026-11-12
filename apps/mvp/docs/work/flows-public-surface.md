---
title: Keep the flows namespace inventory and setup docs current
status: done
area: sdk
owner: codex
updated: 2026-11-12
links: ["https://github.com/smithersai/smithers/issues/4896"]
---

The `@smthrs/flows` namespace inventory must include every public export in
sorted order. The authoring lists must cover the flat `@smthrs/flow` surface.
Installation and quickstart examples must import `NodeRuntime` and
`SandboxedFlow` from `@smthrs/platform-node` and use the current synchronized
release candidate with its exact Effect peer version.

Regression checks live in `packages/smithers/flows/test/index.test.ts` and
`apps/site/scripts/api-reference.test.mjs`. The new documentation checks fail
against the original documentation and pass after the corrections.

Validation: the runtime inventory regression fails without the fix and passes
with it. The two new documentation contracts, package typecheck, changed-file
formatting, generated API/LLM drift checks and all 52 published-package tarball
checks pass. The broader suites retain unrelated tooling-roster, source-loader,
support-table and nested-package formatting failures.

The installed-consumer quickstart check cannot pass until the documented
release candidate is published on npm. Both setup pages explain this
publication prerequisite. The normal docs flows also require the native
filesystem helper; their underlying content and tarball checks pass directly.
