---
title: Gateway diagnosis and contract documentation
status: done
area: gateway
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4915]
---

Clear a run's previous failure cause with its fault when a later status is
recorded, including carried event windows and restored digests. Pin the
successful resume behavior through the run summary and generated histories.
Correct the protected mount and approval error lists, and check both against
their runtime declarations. Dot-segment routing documentation already agrees
with the router.

No new library, public API, or platform service is needed. The change uses the
existing gateway fold, projection, RPC schemas, and documentation checks
(SDK-11, TEST-2, SDK-14).

Validation: the two regression suites failed 10 new cases on the unchanged
implementation, then the full gateway suite passed 979 tests in 39 files at
100% statements, branches, functions, and lines. Package type checking, lint,
and formatting passed. Documentation synchronization and checking completed
as durable flows; all 52 published package tarballs passed. Generated API and
LLM-reference drift checks passed. Astra and Fable reviews found no actionable
issues. The handler table writes no run status; status transitions remain the
only source of failure-detail clearing.
