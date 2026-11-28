---
title: Show Cloudflare reservations as waiting in Fleet
status: in-progress
area: fleet
owner: codex-dogfood
updated: 2026-11-27
links: []
---

Compare Fleet session states with the provider inventory. Preserve the host's count of outstanding sessions and its unknown capacity.

The candidate collector read 87 Waiting and four Working from the real cfbox inventory. The focused CLI collector suite passed. The reporting host still needs the updated collector before the production Fleet counts can be verified. This uses the existing @smthrs/cli NodeCollectors service.
