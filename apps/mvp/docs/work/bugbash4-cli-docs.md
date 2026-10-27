---
title: Bug bash 4 CLI and library references
status: blocked
area: cli-docs
owner: bb5-cli-docs
updated: 2026-10-27
links: []
---

All eleven assigned source fixes and their generated pages are complete.
Catalog entries: @smthrs/cli, @smthrs/platform-node and @smthrs/flows;
existing package references and site projections. No new library.

The native host uses the existing public Runtime subpath because the aggregate
barrel loads browser sync and lib0's localStorage probe. Runtime APIs and normal
Node warnings remain intact. The real Node 26.10 startup regression fails with
the original import and passes with the fix.

Latitude: 27 focused CLI tests and eight reference tests pass; all fourteen
regressions fail on original sources. Compiler, import rules, app/CLI/site lint,
seven projection checks, 51 package tarballs and the 115-page site build pass.

Landing gates remain red: the SDK suite has nine failures matching the original
import exactly (1,290 pass, eleven skip); SDK lint has two unchanged
EgressHttpClient errors; the site has its unchanged hostname assertion.
Requested 100% coverage is unproved: focused Tui.ts L73.33/B75/F68.18/S68.25%.
Production docs E2E and GIF evidence await deployment; api-reference.spec.ts
requires docsSite. W13's TUI guide/generator changes must be retained on landing.
No push, deployment or GitHub writes were performed.
