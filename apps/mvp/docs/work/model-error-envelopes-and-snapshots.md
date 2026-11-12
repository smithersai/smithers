---
title: Model error envelopes and dated snapshot limits
status: done
area: sdk
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4743
---

Use the library catalog's `@smthrs/model` provider protocols, route and request
executor. Preserve Chat Completions provider messages and authentication recovery
for array-wrapped error bodies. Resolve dated snapshots through their families
in the model catalog without changing cloud-prefixed identifiers.

Regression checks cover provider messages, an HTTP `400` authentication
rejection and recovery through the real executor with an injected HTTP service,
catalog context windows and output ceilings, and the Anthropic request budget.

## Evidence

With the two production modules restored to their original versions, the four
regression files report `27 failed, 253 passed`. The failures include the
missing provider message, skipped authentication refresh, conservative dated
context window, and `max_tokens: 4096` instead of `128000`.

With the fix, the complete model suite reports `1219 passed, 9 skipped`.
The existing skips are unchanged. Statements, branches, functions and lines
all reach `100%` coverage with the package's thresholds unchanged.

The package's `check`, `lint` and `circular` scripts pass. Source-loading child
Node processes preload `vibelang/register`; lint runs on the clean source tree
before typecheck emits declaration artifacts.

`pnpm docs:sync`, `pnpm docs:check` and `pnpm run target-index` pass with the
native filesystem helper supplied as a build input. The API and LLM projection
generators and their drift checks also pass after the final wording correction.
