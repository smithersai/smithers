---
title: Repository home copy feedback and native flow links
status: done
area: ui
owner: Codex mini/fix-packages-smithers-ui-src-repository-home-072388
updated: 2026-10-21
links: [../../../../packages/smithers/ui/docs/guides/show-a-repository-home.md]
---

Reproduce copy failures without visible or announced feedback and native links that cannot carry a selected flow. Use the library catalog's repository-home entry (`@smthrs/ui`), its existing copy state machine, and host-provided flow URLs: the generic component cannot choose an application's routes. Keep string `askHref` compatibility; accept a resolver for flow-specific destinations. No new library or feature plugin is needed for these component corrections.

Copy failures now show `Copy failed` in the error color and update a persistent polite status region. Success clears the failure and announces `Copied`. A host can pass an `askHref(flow)` resolver so prompt, app and live flow anchors carry the selected flow through native navigation; existing string destinations keep their original behavior. The guide demonstrates the resolver and its route contract.

Validation on Node 26.5.0 after `pnpm install --frozen-lockfile --offline`:

- Before the fix, `bun test tests/repository-home-feedback-navigation.test.tsx`: 0 passed, 5 failed. Both copy buttons still said `Copy`, no error style existed, and flow-specific native destinations were unavailable.
- Baseline `bun test tests`: 2,560 passed; only the five new regressions failed.
- After the fix, `bun test tests/repository-home-feedback-navigation.test.tsx tests/repository-home.test.tsx`: 68 passed, 0 failed. Faults enter through an Effect clipboard service; successful retries use the real DOM clipboard. No fixed waits or mocks were added.
- Final `bun test tests`: 2,565 passed, 0 failed, across 180 files.
- `pnpm --filter @smthrs/ui check`: passed.
- `pnpm exec smithers-build test '//packages/smithers/ui:importRules'`: passed, one target ran, zero failures.
- Playwright: not run (mini clone).
