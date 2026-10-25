---
title: Deployment e2e uses personal models
status: blocked
area: e2e
owner: codex-e2e-byok
updated: 2026-10-25
links: []
---
Deployment setup saves and tests an explicit personal model. Model-dependent specs declare their prerequisite and model removal restores the shared account in teardown.
Library catalog: existing @smthrs/model ModelProxy endpoint; tests exercise the product personal-model API, which runs its existing durable flows.

Implementation committed on builder/e2e-byok. Latitude typecheck passed; final regression/collection receipts are queued on shared runners. This environment has no explicit E2E_PERSONAL_MODEL_KEY, and the mini has no live model, so authenticated BYOK setup plus a real answer remains unproven.
