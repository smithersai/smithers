---
title: Preserve finished answer metadata across recovery
status: done
area: agent
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5264
---

The responding action seals its text, final parts, rounded usage and failure
reason together. Settlement consumes this durable result through retries and
engine restarts instead of reading the live streaming map.

Uses the library catalog's `@smthrs/agent` `AgentAction.implement` and
`@smthrs/flow` action registration; no new retry or recovery mechanism.

Regression coverage crashes the real durable engine after the response seals,
retries settlement on a replacement engine, and checks successful usage,
completed tool parts and frame exhaustion without repeating model or tool calls.

Validation: both crash/retry regressions fail before the change; all 34 agent
integration tests and 29 answer/progress/settlement tests pass afterward.
The app's four typechecks pass, and ESLint passes for the changed production files.
