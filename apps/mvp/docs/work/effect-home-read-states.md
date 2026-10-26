---
title: Repository home read states
status: blocked
area: home
owner: effect-home
updated: 2026-10-26
links: []
---
Refs without a ready mirror head answer 204 with x-repo-state: not_imported and private no-store. A missing ref in a ready mirror remains 404; database and provider failures remain errors. The browser keeps its existing missing-mirror state.

Decision 0079 hides prompt and app blocks on home-fixture in deployments; its declared text, links and Markdown remain visible and its Code navigation still works.

Library catalog: @smthrs/effect-code-storage for mirror reads and @smthrs/integrations for GitHub About. This fixes core read infrastructure, adding no feature or library.

Validation: Latitude typecheck, importRules and focused lint pass. The 102 focused tests pass with 100% statements, branches, functions and lines on RepoApi, RepoReads and the browser client. Mini: 4 passed including setup, 4 capability/target skips; home-fixture needs Code Storage. No production requests were made.

Earlier pass (before the live tail): About remained unresolved: its required GitHub read can answer rate_limited or github_unavailable; a cold first-read wait or a caught defect answers unavailable. Missing optional parts already return a successful partial answer. Existing injected-service tests cover those distinctions. The reported production 503 has no saved response code or matching log in the available evidence, so it cannot yet be classified and has not been suppressed.

Both new refs regressions fail against 66ebecb6: the handler returns 404 instead of 204, and the browser client refuses 204 without the missing-mirror result. Decision 0113 records the wire contract.

Resumed: live production tail found anonymous About repository reads rate limited (GitHub 403, remaining 0). Curated public homes use the deployment read token over REST; arbitrary visitor input retains its existing token policy. Navigation was intentionally retained by feb24d7c; align the stale absent-home spec and docs.

Current validation: Latitude typecheck and importRules pass. Mini wrapper requested both home specs, but SSH cannot resolve the configured mini hostname; no browser test started. Production tail evidence is kept outside the repository. Finished work still needs the lander deployment and focused production confirmation.

Final focused validation: 23 About tests pass, with 100% statements, branches, functions and lines on RepoAbout.ts. Production-module lint passes. The mini launch was stopped after its DNS failure was independently confirmed; no slot or remote run was acquired. Blocked only on end-to-end confirmation after landing.
