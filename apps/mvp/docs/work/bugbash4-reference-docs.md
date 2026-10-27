---
title: Bug bash 4 reference omissions
status: done
area: docs
owner: bb6-ref-docs
updated: 2026-10-27
links: []
---

Fix sd4-reference-4 through sd4-reference-8 on bb5-cli-docs. Preserve its
multipart digest documentation and build/targets/views roster entries.
Catalog: cli, build-cli, crypto, ui, targets.

Latitude: all five original documentation regressions fail, and all 23 current
reference checks pass. Docs sync, all 51 published tarball checks, the CLI,
build, crypto, UI and site docs targets, and target-index generation and drift
checks pass. The broader site check retains its existing hostname-literal
assertion failure in the app's Alchemy declaration (115 of 116 tests pass).
