---
title: CLI stack, command spelling and egress regression tests
status: done
area: cli
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5152]
---

Replace stack test method spies with real temporary `jj` repositories and a
stateful loopback HTTP service. Assert pushed bookmarks, rebased parents, pull
request state, saved stack mappings and deletion through the real client.
Faults enter through an injected Effect service (`TEST-2` and `TEST-7`).

Validate unknown command names and group children through the complete printed
command scanner, preserving executable manifest entries separately from group
prefixes. Keep process-global data-home ownership around the whole egress
fixture and force both concurrent completion orders.

The baseline regressions reproduced accepted misspelled commands and concurrent
data-home leaks. All 144 focused tests, the package typecheck and lint pass.
Omitting stack fetch, push, rebase or deletion makes its behavioral test fail.

The coverage-enabled package run passed 6,024 tests and failed 237; all three
changed suites passed. Five sampled failure categories also fail on the
unchanged baseline: missing native helper, D-Bus or SSH services, unresolved
TUI dependencies and permission-sensitive tests running as root. This is not a
green package-wide coverage receipt.
