---
title: Diagnose the Windows Node host suite
status: in-progress
area: sdk
owner: codex-artifact-repair
updated: 2026-11-27
links:
  - https://github.com/smithersai/smithers/actions/runs/46041405705/job/140653392895
  - https://github.com/smithersai/smithers/actions/runs/46041119917/job/140648808834
---

The Windows Node host Jj contract exceeded its 30-second budget once. The shared
contract now records each real operation's start, finish, elapsed time and outcome.
Keep the suite open until Windows supplies a new receipt. Both Windows runs also
missed the independent 100% package coverage gate, including POSIX process-table
and destination-broker paths.
