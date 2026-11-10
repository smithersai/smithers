---
title: Hosted-site sign-in broker
status: done
area: authentication
owner: Codex vl-authbroker
updated: 2026-11-09
links:
  - ../../../vibelang/wiki/decisions/0029-hosted-sign-in-broker.md
---

Implemented VL-33 in shared integrations and both hosted apps, with protocol, workerd and browser checks on nyc-01. The lead coordinates
smithers.sh's deployment with its owner; this lane never deploys.

Resumed for temporary GitHub token cleanup: regressions for ten-token eviction and failed revocation in unit/workerd; durable cleanup for failed ordinary callbacks; fixed-vocabulary counters/logs. No deployment.

Temporary-token cleanup is implemented and verified: 1,398 VibeLang unit tests, 65 workerd tests, three browser round trips, and all four integrations coverage metrics at 100%. The ordinary MVP failure-path regression and adapter checks pass; the unrelated full-file Electric failure reproduces on the parent. The lead deploys.
