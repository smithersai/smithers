---
title: Signed-out run credentials
status: done
area: app
owner: codex visitor-credential
updated: 2026-10-25
links: [../features/sign-in.md]
---

Guard every run credential request when the tab says nobody is signed in.
Library catalog: local state and sync (`@smthrs/effect-tanstack-db`), durable flows (`@smthrs/flow`).

Every root run now asks its tab about sign-in, including agent and flow roots; nested runs inherit its anonymous state.
Queued-write credential renewal checks the same real sign-in store and refuses locally when signed out.
Both regressions failed before the fix. Latitude: typecheck, importRules, 49 focused tests passed;
`credentials.ts` and `bearer.ts` reached 100% statements, branches, functions and lines.
Mac mini: vibelang-visitor.spec.ts ran model-free (2 passed; file test skipped without Code Storage).
The file-page production e2e remains to be run after landing; no production pass is claimed.
