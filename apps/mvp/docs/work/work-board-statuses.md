---
title: Finished work belongs in Done
status: done
area: process
owner: Codex
updated: 2026-11-13
links: [../../../maintainer-site/README.md]
---

Use the Work board's documented status vocabulary. Finished notes use `done`;
unsupported status values must fail validation rather than create extra columns
and inflate the open count. Review and activation gates remain unfinished.

Keep the existing warning for notes without a status and the existing area
validation. Historical notes below subdirectories do not enter the Work board.

Validation covers the real site builder, every supported status, unsupported
completion aliases and malformed status values, unchanged published output on
failure, nested historical notes, and the repository's current work notes.

The 45 completion aliases now use `done`. The other 40 unsupported values
use existing open statuses: review, landing and implemented work stays
`in-progress`; parked work, decisions and activation gates are `blocked`;
planned work is `todo`. Note bodies and ownership remain unchanged.

The regression suite fails twice against the original builder and metadata,
and all four regressions pass with the fix. The full maintainer-site suite
passes all 109 tests, including its real-browser queue checks.
