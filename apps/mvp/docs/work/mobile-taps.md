---
title: Mobile tap targets and settings audit
status: blocked
area: mobile
owner: Codex mobile-taps
updated: 2026-10-26
links: [../features/personal-model.md]
---

Use the library catalog's Render UI entry, @smthrs/ui control-height tokens.
Fix back and release targets; align the settings audit with the two-key form;
stop recording snapshot bodies once browser recording ends.

Latitude: 23 focused browser/component tests pass at 390, 768 and 1280;
shared UI suite passes 2,661 tests. Typecheck and importRules pass.
The model audit now checks both protocol groups and every tier's key selector.
The audit records bodies after requestfinished, avoiding unfinished response streams.

Red receipt: restoring the prior styles makes the three new target tests fail;
the current styles pass all three. The CSS modules execute at 100% lines and
functions in the focused shared UI coverage run (constant styles, no branches).
Mini browser verification could not acquire the shared runner during this work.
The queued request was cancelled without changing any shared lock. No production
run was requested or made; the end-to-end after-count and teardown proof remain open.
