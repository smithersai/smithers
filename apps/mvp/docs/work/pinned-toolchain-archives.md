---
title: Pinned toolchain archive delivery
status: in-progress
area: repository
owner: maintainers
updated: 2026-11-06
links:
  - ../../../../CONTRIBUTING.md
---

Workspace manifests referenced local compiler packages absent from a fresh
checkout. Include the four existing package archives with their unchanged content
addresses. The regression reads declared workspace membership and verifies every
local compiler archive reference, including peer dependencies.

Validation covers the missing-archive failure, matching archive checksums, a
frozen dependency install and the registered repository contract target. The dependency versions and public
package APIs stay unchanged.
