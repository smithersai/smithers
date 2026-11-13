---
title: MCP transport lifecycle regression coverage
status: done
area: mcp
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4938
---

Cover child termination while the caller scope stays open, CRLF framing across
empty chunks, and deterministic request cancellation ordering.

Library catalog: use the existing `@smthrs/mcp` transport and injected
Effect process and HTTP services. The child cleanup and empty-chunk source fixes
are already present; this change strengthens their regression coverage.

Validation: all 495 MCP tests pass with 100% statement, branch, function and
line coverage; package typecheck and lint pass. Five production-code mutations
are rejected by behavioral assertions: omitted terminal cleanup, lost CR state,
cancellation delayed until after a settled tool call, cancelled initialization,
and delayed request cleanup. Production sources are restored after each probe.
The existing real-process test also verifies that a protocol error stops the
child before its scope closes.

Astra and Fable reviewed the tests. The cancellation deadline test captures the
fiber state at 300 ms and releases faulty cleanup before asserting, so a broken
cleanup reports the missed deadline instead of hanging scope finalization.
