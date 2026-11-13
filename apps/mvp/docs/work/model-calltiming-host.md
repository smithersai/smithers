---
title: Model call timing uses injected host storage
status: done
area: sdk
owner: Codex Sol (calltiming-host)
updated: 2026-10-22
links:
  - ../../../../packages/smithers/agent/model/src/internal/CallTiming.ts
  - ../../../../packages/smithers/agent/model/src/internal/WireTrace.ts
---

Keep timing and cache diagnostics platform neutral. Replace ambient synchronous wire-trace file writes with an optional Effect sink backed by the host FileSystem.

Library catalog entries: `@smthrs/model` for model calls; `@smthrs/platform-node`, `-bun`, `-browser` for filesystem services. The existing timing span attributes remain available without a file sink.


## Result and proof

- The write was in `internal/WireTrace`; `CallTiming` only uses its injected Effect clock. Read its callers in Route, Model and Evaluator.
- Added `WireTrace.WireTrace` and `layerFileSystem(path)`, captured during route construction. No sink means no ambient environment or filesystem access. File appends use the existing Node host filesystem service; no host-to-model dependency was added.
- Keep file diagnostics because cache-prefix hashes and provider response headers are absent from the existing spans. Timing remains on settle events, errors and Route/chat span attributes.
- Browser/Worker root execution failed first at the ambient environment read, then passed against a real HTTP server. Injected filesystem tests cover JSONL pairing, append, unwritable destinations, errors, defects, deadlines and cancellation. Interrupted streams retain response records.
- `pnpm --filter @smthrs/model exec vitest run`: 1,048 passed, 9 live-provider tests skipped; statements 2,706/2,706, branches 2,200/2,200, functions 654/654, lines 2,373/2,373 (all 100%).
- `pnpm --filter @smthrs/model run lint` and `run check`: passed. The package's actual SdkRules ImportRules passed all 3 rules over 82 files; browser and Worker bundles passed the existing HiddenHostAccess analyzer with no model exceptions.
- `pnpm docs:sync`, API/LLM projection drift checks and `pnpm run target-index`: passed. `pnpm docs:check`: passed all 51 published tarballs (run-2 completed).
- Astra review findings were fixed and the final review has no findings. Fable review could not run: default CLI signed out and the configured subscription rotator reported every account failed/cooling. No accounts were reconfigured.
