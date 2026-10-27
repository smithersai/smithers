---
title: "Bug bash 4: CLI scaffolds and durable quickstart"
status: blocked
area: cli
owner: bb6-scaffold
updated: 2026-10-27
links:
  - packages/smithers/flows/engine-store/docs/quickstart.md
  - packages/smithers/src/cli/Generate.ts
---

Reproduce and fix SE4-DURABLE-3, se4-scaffold-1 and se4-scaffold-10.
W13/bb3-cli and W14/bb5-cli-docs reports contain no fixes for these findings.
The database contract explicitly requires existing parent directories; fix the
quickstart's setup and exercise an absent workspace with the real durable engine.
Use the catalog's database, engine-store, platform-node and targets libraries.
Validate on Latitude; no local installs, pushes, deployments or GitHub writes.

All three findings have source fixes and old-code failing regressions. The
quickstart creates its SQLite parent through the real Node filesystem and its
literal TypeScript blocks run from a fresh directory. CI generation selects
both executable renderers (`Github.CiGen` and the public `GithubCiGen`) and
refuses inert workflows. Global skill sync adopts orphaned generated create-app
skills into Incur's existing agent-aware retirement lifecycle; custom skills
and unrelated metadata are retained. Retired export-fixture entries are gone.

Latitude: 51 focused CLI tests pass; Generate and RetiredSkills have 100% lines,
branches, functions and statements. The quickstart has 100% coverage, including
the literal documentation program. Both package typechecks, CLI lint and both
CLI/flows import-rule targets pass. Docs sync and check pass for 51 tarballs.
All 2,282 engine-store tests pass, but its overall coverage floor fails in
unchanged files (99.97/99.79/99.91/99.97 statements/branches/functions/lines).
Engine-store lint fails on unchanged RetrySource.ts's missing `@since` tag. The
full export-contract suite has the same plugin-surface drift on original and
fixed source; the new retirement regression passes. Whole-file Cli.ts 100%
coverage is not proved. Astra's follow-up review has no remaining findings;
Fable review is blocked because the installed CLI cannot load devalue.
