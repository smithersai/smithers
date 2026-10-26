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

About remains unresolved: its required GitHub read can answer rate_limited or github_unavailable; a cold first-read wait or a caught defect answers unavailable. Missing optional parts already return a successful partial answer. Existing injected-service tests cover those distinctions. The reported production 503 has no saved response code or matching log in the available evidence, so it cannot yet be classified and has not been suppressed.

Both new refs regressions fail against 66ebecb6: the handler returns 404 instead of 204, and the browser client refuses 204 without the missing-mirror result. Decision 0113 records the wire contract.
