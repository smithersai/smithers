---
title: Node host authority regressions
status: done
area: sdk
owner: Codex fix-ackages-smithers-flows-platform-node-src-900640
updated: 2026-10-21
links: [../../../../packages/smithers/flows/platform-node/test/HostSecurityRegressions.test.ts]
---

Six reported constructor and sandbox authority bugs. Seven regression cases failed on the original code on Latitude. Catalog entry: “Spawn a process or touch the filesystem”, using the existing `@smthrs/platform-node` host.

All six findings reproduced and fixed. Rooted hosts fail through the typed layer channel; sandbox reads and directory writes never acquire implicit authority; missing protected bubblewrap paths and Docker loopback requests fail closed.

Validation on Latitude:
- Original code: all seven regression cases failed for the reported reasons.
- Focused unit and containment integration suites: 135 passed.
- Final complete package suite with the native helper built: 1295 passed, 11 skipped, two failures in `NativeRuntimeRestart.test.ts` (edited-body and edited-continuation). Both also failed on the original source; no new failing cases remain. The complete suite is not green and no coverage success is claimed.
- `pnpm check`: passed.
- Package `importRules` target: absent on this revision. The existing ImportRules checker ran directly over the changed tests with the fixed-wait prohibition: passed.
- Changed package files: dprint check passed.

The insecure Seatbelt directory-promotion optimization was removed. Very large exact profiles may hit the platform compiler limit and fail closed; permissions are never widened to fit.
