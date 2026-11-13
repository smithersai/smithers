---
title: Make supervisor and host regression tests reliable
status: done
area: platform-node
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5005
---

Use real helper processes for the Windows guardian protocol, inspect native
permissions for private files and directories, and exercise polling on a live
clock. Remove unused spawner provisioning and the unobserved guest marker write.
Clean language-server fixture directories and seed the store-only test in its
own database. The library catalog's host-services and Node runtime entries
supply the existing services; no public package API changes.

Verification: the focused regressions, related host and language-server suites,
and the store-only case run alone pass. Package typecheck, lint and formatting
pass. The full package suite has 1,527 passing tests, 13 conditional skips and
one home-directory assertion failure also reproduced on unchanged source.
Windows ACL execution and real container/microVM integrations were not run.
