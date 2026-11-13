---
title: Kernel watch options and command authorization
status: completed
area: kernel
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4659
---

Preserved watch options across the guarded filesystem, authorized long rendered
commands and snapshot messages with a bounded SHA-256 resource, and aligned the
kernel dependency and host-extension documentation. Used the library catalog
entry for `@smthrs/crypto` (`digestSync`) for portable SHA-256 identity.
Digest-form literals are reserved too, preventing an exact grant from crossing
between a literal line and the shortened form of another line. Policy guides
explain that matching sees the bounded resource, and attended hosts receive
the full rendered text in `commandLine` metadata.

Validation:

- Targeted tests on the original implementation: 10 failures and 7 passing
  controls. The failures cover dropped watch options, rejected long resources,
  literal resource identity, optional peers and missing host-extension docs.
- Fixed package: 959 tests across 50 files pass with 100% statement, branch,
  function and line coverage. `pnpm check`, `pnpm lint` and `pnpm circular`
  pass, including after rebasing onto the updated dependencies.
- Real Node tests execute long argument and shell commands, answer attended
  requests, reject cross-resource run grants, and observe recursive watch
  events after the installed callback. Boundary tests cover UTF-16 truncation
  and the existing metadata byte limit.
- Documentation projections and LLM bundles regenerated and drift-checked;
  all 52 published-package tarball documentation checks pass. The docs flow
  wrapper could not start without its native helper, so its existing validator
  modules were run directly.
- The site-wide docs suite has two existing failures, both reproduced on the
  unchanged parent: an outdated flows quickstart version and 51 support rows
  for 52 release packages. The suite reports 181 passing tests and one todo.
- Read-only correctness and security reviews passed after correcting the
  digest-form identity collision and documenting bounded policy matching.
