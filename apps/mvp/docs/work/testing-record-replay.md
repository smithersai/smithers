---
title: Testing record and replay consistency
status: blocked
area: testing
owner: codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5074]
---

Use the library catalog's `@smthrs/testing` record-and-replay helpers.
Give recording and replay the same response headers and body serialization,
preserving live credential values only during recording. Correct the model
error-code reference and model identity guide. Describe the remaining root
entry platform dependencies accurately.

The real HTTP recording suite, package typecheck and lint, API projection
drift checks, and package documentation tarball checks pass. The full package
suite also has unrelated failures present on the unchanged base.

The remaining work is the filesystem service requirements for `HttpRecording`,
which remain subject to the public API decision on the issue.
