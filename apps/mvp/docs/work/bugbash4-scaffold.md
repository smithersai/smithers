---
title: "Bug bash 4: CLI scaffolds and durable quickstart"
status: in-progress
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
