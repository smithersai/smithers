---
title: Optional repository home reads
status: blocked
area: home
owner: home-json-404
updated: 2026-10-26
links: []
---
An absent repository home uses an optional blob read (204), rather than a failed request. RepoApi verifies the commit through its tree before answering absent; real failures remain errors. The browser retains its existing absent home state.

Library catalog: @smthrs/views repository home; @smthrs/effect-code-storage repository reads. This fixes existing core read infrastructure, without adding a feature or library.

Latitude: typecheck and importRules pass; 93 focused tests pass with 100% coverage of both changed production files. Both regressions fail against d9e2c5af (404 instead of 204). Mini: 5 passed, 9 failed, 3 skipped. Eight failures are undersized Back to chat tap targets; one is a Vite TS5096 overlay blocking navigation. Home and branch-publish require capabilities unavailable on the mini. Browser proof remains blocked; no production run was attempted.
