---
name: smithers-chain
description: Maintain the existing @smthrs/chain runner, journal replay, catalog handlers, or sandbox boundary.
---

# Existing chain package

Read [the chain README](../../../packages/smithers/agent/chain/README.md) and its tests before changing this package. Keep the main product's single `Agent.Service` loop and `@smthrs/flow` authoring model; this skill is for the existing chain implementation, not a reason to add a second loop or graph API.

`QuickJsRunner.layer()` creates a sealed QuickJS realm per link with memory, stack, and step limits and no host globals. `ScriptRunner.layerInProcess` has no isolation and belongs only in trusted fixtures; a script there can reach process globals and dynamic imports.

The journal is the state authority. A matching settled call replays once, but a handler may execute again if it succeeded before `CallSettled` was recorded. Make external effects idempotent or give them an external durable key from the stable catalog call slot (`chain`, `link`, `ordinal`). Preserve the declaration/script identity checks that fail on replay divergence. Verify a crash after handler success and before settle when changing recovery.
