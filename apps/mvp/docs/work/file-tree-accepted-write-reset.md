---
title: Retry an accepted issue write after a transport failure
status: review
area: flows
owner: codex-smmredact
updated: 2026-11-04
links: []
---

Uses the catalogued @smthrs/flow round outcomes. The fake records the accepted
machine write before destroying the socket. The regression replays the unfinished
round, re-sends the same write ID, receives 200 and settles exactly one issue.
The write stays pending until after re-send so the issues shape cannot bypass it.
The fake's request records retain response statuses to prove the 200.

Validation runs the file-tree suites and a fresh-ID mutation in cfbox, comparing
failing names with pinned main 7bc198f5. Test, cleanup and exact-change review
receipts are retained in the lane's operations record. No landing or push is authorized.
