---
title: Code browsing round two
status: in-review
area: repo
owner: bb2-code
updated: 2026-10-27
links: []
---
Catalog: `@smthrs/repo-view`, `@smthrs/ui`; existing GitHub About and Code Storage reads.

Root previews come from `worker/RepoAbout.ts` through `worker/about/GitHubRead.ts`, cached in Postgres. They contain only the root listing and README. Arbitrary folders/files need Code Storage's clone: adding anonymous recursive GitHub reads would spend the shared visitor quota, and an installation token cannot be used for an uninstalled repository. Explain this prerequisite in the existing empty state.

Production: Effect now has a clone; deep folders, its visitor README, missing folders, and desktop README load without failed requests. The pre-clone state reproduced on Effect-TS/language-service. Offline cold file navigation still leaves pending chrome without a way back.

Offline recovery: uncached pending file and issue views now retain a navigation link and render the shared connection's Offline state. Loaded issue pages use the same fallback while the requested issue is absent from the device. Cached files and issues keep their normal views. No extra network operation or retry mechanism was added. `OfflinePages.test.ts` drives the real Chat Effect service offline, back online, then follows Back to chat; restoring the old BranchPendingScreen fails at the missing link. `code-offline.spec.ts` verifies the actual browser network transition after deploy. Existing connection telemetry covers these states.


VE3 reproduced: CONTRIBUTING.md under `/tree/` showed Not found despite appearing in the tree. Confirmed file paths now replace the route with `/blob/`; directories, absent paths, unresolved trees and truncated omissions do not redirect. The existing router handles navigation; no new action service or dependency is needed. `tree-file.spec.ts` covers signed-in and visitor redirects plus reload.

Final Latitude receipt: typecheck, importRules and lint pass; 51 focused tests pass; `contract.ts` and `view.ts` reach 100% statements, branches, functions and lines. TSX views are outside the configured unit coverage gate; DOM tests verify pending/offline transitions and navigation, and deployment specs remain the lander's verification. No mini run or deployment was attempted.

Other production findings: missing folder shows Not found, desktop README/package.json load, Effect deep folders and visitor files load now that the shared clone exists, the tree paints in the desktop screenshot, the phone bell stays beside its header, and the visitor tree renders. Schema.ts is requested by code-intel's language server read callback; W11's size metadata response removed the observed 413. These probes had no failed requests except the uncloned repository's anonymous About quota refusal and the intentional offline transitions.
