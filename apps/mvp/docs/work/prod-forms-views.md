---
title: Production forms and generated views proof
status: done
area: views
owner: codex-prod-forms-views
updated: 2026-10-25
links: [../decisions/0004-agent-ui-codemode-and-rendering.md, ../features/views.md]
---

Add real-model journeys beside the unchanged scripted forms and generated-view cases. Declare member, ownConversation and liveModel so deployment runs use the test account's own branch. Ask to clone without a URL, submit the repository form and observe the next answer; ask for a tic-tac-toe board, open it full screen and make a move. Match behavior rather than model wording, and identify newly created views rather than earlier conversation history.

Catalog: existing `@smthrs/views` and `@smthrs/ui` generated-view and form interfaces; no new library, product behavior or public API. The lead runs production. Validate local availability, discovery/skips, all app typecheck projects, importRules and e2e unit tests.

Implemented: live describe scopes declare the three needs before devices open. Both journeys identify a newly written view and check its answer id, so earlier forms/boards cannot satisfy them. The form request explicitly collects its URL again because the deployment conversation persists across runs; its captured schema selects exactly one URL/URI/link field by input name. Submission checks the real 202, values, disabled form and completed next answer without reply wording. The board request explicitly asks for nine empty buttons and text X/O marks, leaving titles, accessible labels and event names variable. Full screen opens the same id; a cell click must receive an advanced server revision, paint its mark and retain it inline after returning. The scripted case bodies remain byte-for-byte unchanged.

Validation (Node 26.5.0): frozen install passed; discovery initially failed with no matching live cases, then listed four cases locally and seven including deployment auth. `pnpm --filter @smthrs/mvp typecheck` passed all four projects with zero errors; `pnpm exec smithers-build test '//apps/mvp:importRules'` passed. `pnpm --filter @smthrs/mvp test e2e --coverage.enabled=false --maxWorkers=2` under the shared suite lock passed 14 files, 133 tests and one existing skip (an earlier unlocked run timed out in the unchanged Electric snapshot setup). Focused unit execution has no full-app coverage claim; no production logic changed.

Local browser execution with `BASE_URL=https://localhost:1443` and the live-case grep loaded both cases and skipped both with the recorded `needs liveModel` reason: no CEREBRAS_API_KEY in this run's environment and no apps/mvp/.env. The documented Mac mini farm has no model; no farm files were touched. No real-model behavior, production run or GIF is claimed. The lead runs these on production. Astra reviewed, its three robustness findings were fixed, and its second review found no remaining blockers. Fable was attempted after Astra but `claude-rr` reported every account failed or cooling, tried none; no reset or account change.
