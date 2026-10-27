---
title: Package bug bash round 4 CLI fixes
status: in-progress
area: sdk
owner: bb6-cli
updated: 2026-10-27
links: []
---

Confirmed findings: memory-eval 1, 2, 4, 5, 9; mcp 2, 4, 5, 6; local-cli 4, 9, 11.
Catalog entries: @smthrs/cli, @smthrs/memory, @smthrs/evals, @smthrs/build-cli.
Reproduce on Latitude before fixing; one commit per finding, with the three memory help omissions grouped.
W13 bb3-cli and W14 bb5-cli-docs reports contain no fixes for these findings. The concurrent reference and scaffold workstreams own other CLI docs and generators.
Filegroup remains cacheable as specified by the existing caching contract; execution must read and store its successful result.
