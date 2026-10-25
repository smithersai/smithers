---
title: Fail chat promptly when model credit or quota is spent
status: blocked
area: model
owner: quota-fail-fast
updated: 2026-10-25
links:
  - ../features/model-endpoint.md
---

Use the library catalog's model proxy and durable model step entries. Deployment quota and credit refusals are terminal; plain rate limits keep durable backoff. Core model admission and answer failure reporting are shared infrastructure.

Decision: [0100](../decisions/0100-terminal-model-refusals.md). Migration 0059 adds the quota failure; the synced message schema is version 4. Local browser validation is blocked before Playwright: `pnpm dev` loads `vibelang/register` and reports TS5096 for `allowImportingTsExtensions` in the app tsconfig, although that config sets `noEmit: true`. The mini runner never reaches `/api/auth/session`. This is the minimal tooling reproduction; no application configuration workaround was added.

Latitude validation: typecheck and importRules pass; the full app suite passes 4,489 tests with 100% statements, branches, functions and lines (3 expected failures and 17 skipped). No SDK package changed. The settlement crash regression fails with `model_error` on the old flow and passes with `quota` on the fixed flow, with one provider call. Astra and Fable reviewed the change; their findings are fixed. Browser/production proof remains outstanding; the lander regenerates the device schema lock before landing.
