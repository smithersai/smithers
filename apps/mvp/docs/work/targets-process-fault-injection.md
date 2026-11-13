---
title: Review tests inject process faults through Effect
status: done
area: targets
owner: Claude
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5063
---

Replace module mocks and the global platform override in the review tests with
the existing internal `Process` Effect capability. Keep real child processes
and their native cleanup. The library catalog's `@smthrs/platform-node` process
adapter remains the host implementation; no new dependency is needed.

The git-output and git-grep helpers provide `Process` and assert that their
redirected processes ran. Stdin refusal cases wrap the real child's sink through
the same service and assert that a closed pipe was observed. The Windows module
case supplies the selection platform on this internal capability, checks literal
Node argv and prompt delivery, and checks that the host platform never changes.
The executable-identity caller retains the native platform explicitly.

The rewritten Windows case failed against the original production code and
passes with the fix. The focused suites pass all 123 cases; package typecheck
and lint pass. The complete package suite and its coverage gate also pass with the process
permissions, sandbox tools and dependency closure the suite requires. Two independent
reviews passed.
