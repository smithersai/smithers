---
title: Code browsing round two
status: in-progress
area: repo
owner: bb2-code
updated: 2026-10-26
links: []
---
Catalog: `@smthrs/repo-view`, `@smthrs/ui`; existing GitHub About and Code Storage reads.

Root previews come from `worker/RepoAbout.ts` through `worker/about/GitHubRead.ts`, cached in Postgres. They contain only the root listing and README. Arbitrary folders/files need Code Storage's clone: adding anonymous recursive GitHub reads would spend the shared visitor quota, and an installation token cannot be used for an uninstalled repository. Explain this prerequisite in the existing empty state.

Production: Effect now has a clone; deep folders, its visitor README, missing folders, and desktop README load without failed requests. The pre-clone state reproduced on Effect-TS/language-service. Offline cold file navigation still leaves pending chrome without a way back.

Offline recovery: uncached pending file and issue views now retain a navigation link and render the shared connection's Offline state. Loaded issue pages use the same fallback while the requested issue is absent from the device. Cached files and issues keep their normal views. No extra network operation or retry mechanism was added. `OfflinePages.test.ts` drives the real Chat Effect service offline, back online, then follows Back to chat; restoring the old BranchPendingScreen fails at the missing link. `code-offline.spec.ts` verifies the actual browser network transition after deploy. Existing connection telemetry covers these states.
