---
title: Benchmark result recovery
status: done
area: agent benchmarks
owner: Codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/4799]
---

Fix the Harbor adapter's handling of incomplete result files, command-owned SSH
failures and fallback commit failures. Keep completed command output and preserve
failed commit receipts. Extend the existing offline fixtures; no library or
public API changes are needed.

Validation: all Harbor offline fixtures pass. The new requeue, runner exec,
docker shim and commit-failure checks fail against the original production
files. Python syntax checks and the focused Ruff checks pass. Failed commits
retain their trajectory, token totals and context metadata. Runner-installed
Harbor checks remain optional and were not run.
