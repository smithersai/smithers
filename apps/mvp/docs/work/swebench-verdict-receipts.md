---
title: Preserve benchmark verdict receipts
status: done
area: benchmarks
owner: codex
updated: 2026-11-11
links:
  - https://github.com/smithersai/smithers/issues/5239
---

The full-benchmark worker returned success after a failed verdict append and
could publish cleanup without a verdict. Resume then skipped the instance
permanently.

The worker now stops on a failed receipt append. Resume requires a recognized
verdict, and retry preserves the previous archive and evaluator report before
replacing an attempt. This repairs the existing operator rig, adds no library,
and changes no public package API.

Regression evidence: the original worker returned success with only
`pulled`, `ran` and `cleaned` rows after a transient graded-receipt failure.
The fixed worker stops before deletion and retains the paid evidence.

All offline fixtures passed across the full run and remaining-fixture rerun.
Package typecheck, lint, target-index regeneration and its drift check passed.
Worker receipts, driver drain and backfill tests cover missing or invalid
verdicts; existing quoting coverage remains intact. Independent review passed.
Validation used real filesystem failures and the existing token-free run and
evaluator seams, without Docker or funded model calls.
