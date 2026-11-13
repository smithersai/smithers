---
title: Model host diagnostic and callback boundaries
status: done
area: sdk
owner: codex-mini-899176
updated: 2026-10-21
links: [../../../../packages/smithers/agent/model-host/README.md]
---

Fixed eight reproduced findings using the library catalog's `@smthrs/model-host` entry; no new dependency or runtime.

- Diagnostic event and phase labels use fixed vocabulary; fields use named measurements and approved string values. Credential-shaped strings and keys are rejected.
- Diagnostic observations fork in the calling Effect, inherit its context, and stop with the supplied scope. Fast failures remain visible past the detail limit, including HTTP 200 receipts with invalid shape or integrity.
- Source callbacks refuse redirects and share the API response reader's streamed 4 MiB byte bound. Exact bounds and multibyte UTF-8 are covered against real HTTP servers.
- Form tool results acknowledge requests without claiming browser completion.
- Credential refresh returns an Effect with a failure channel and cooperative cancellation. Private errors become `unreachable` without their content.

Before changing production code, focused regressions demonstrated label/content leakage, credential-shaped token leakage, lost caller context (`default` instead of `host-context`), suppressed fast failures, followed redirects, accepted oversized JSON, false form completion, and ignored Effect credential failures. Separate original-code refresh checks failed both failure-channel and cancellation regressions. Additional receipt regressions failed before their logging fixes.

Validation on Node 26.5.0:

- `pnpm install --frozen-lockfile --offline`: passed; no online fallback needed.
- `pnpm --dir packages/smithers/agent/model-host exec vitest run`: 479 passed across 24 files; statements 1359/1359, branches 983/983, functions 311/311, lines 1172/1172.
- `pnpm --dir packages/smithers/agent/model-host exec tsc -p tsconfig.test.json --noEmit`: passed.
- Changed-source ESLint and `pnpm exec smithers-build test '//packages/smithers/agent/model-host:importRules'`: passed.
- E2e: not run (mini clone).

Not reproduced/fixed: host-turn continuation and ordinal recovery. The current public protocol has no persisted tool-result/held-call checkpoint or restore API to exercise. No failing supported recovery regression was established, so this change does not claim to fix recovery. The limitation is documented in the package's host tools guide.
