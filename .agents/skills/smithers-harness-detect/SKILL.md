---
name: smithers-harness-detect
description: Change local coding-harness discovery, account status, model flag detection, or version probes.
---

# Harness detection

Read [the harness-detect README](../../../packages/smithers/agent/harness-detect/README.md) and the shared harness contracts in `packages/rpc/src/LocalApp.ts` and launch metadata in `packages/rpc/src/AgentRoles.ts` before changing a detector. The package is pure over an injected `HarnessHost`; filesystem and process probes belong in the adapter. Keep binary search, account status, and model flags grounded in the installed harness's actual help and observed files.

A version probe runs only `--version` with `probeEnv`'s `PROBE_ENV_KEYS` allowlist. Do not pass session or vendor credentials to the child; the live adapter also owns sandboxing and timeout. The Codex JWT email claim is decoded without verification and must not be returned as an authenticated identity. Test the injected host with fixture paths and a probe environment that excludes unrelated tokens.

## Environment markers

[Agent detection evidence](../../../packages/smithers/build/build-cli/docs/reference/agent-detection.md) lists the variable that marks each agent's child processes. In non-interactive modes (probed 2026-09-12), only Claude Code sets `AI_AGENT` (`claude-code_<ver>_agent`); Codex and OpenCode don't, and Codex sets `CODEX_SANDBOX=seatbelt` only when sandboxed. The interactive Codex and OpenCode TUIs were not probed.
