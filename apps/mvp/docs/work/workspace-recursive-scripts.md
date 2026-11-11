---
title: Recursive workspace script scheduling
status: done
area: repository
owner: maintainers
updated: 2026-11-06
links:
  - ../../../../CONTRIBUTING.md
---

Recursive package commands stopped before running any script when test dependencies
formed a cycle. Enable the package manager's explicit cycle policy and verify actual
recursive execution on the repository and generated cyclic and acyclic package graphs.

The repository scheduling regression and generated package graphs pass with the
explicit cycle policy. Source import cycle checks remain a separate gate.
