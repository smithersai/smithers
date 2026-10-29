---
title: Repair CI UI probes and TUI suites
status: done
area: build
owner: codex-ci-ui
updated: 2026-10-29
links: []
---

All five assigned CI targets pass on Latitude with CI's Bun 1.4.1, Node 26.5.0,
Chromium and tmux. No known-red exemption or coverage floor changed.

Browser launch failures name their probe and preserve the cause. CI declares
the pinned browser installation, and terminal unit tests select their directory.
The mobile bell assertion follows its existing unread-count layout.

TUI fixes cover runtime failure fixtures, final-frame questions, redacted
Cloud details, card focus across key bursts and wrapped Vim filenames. Node
keeps SIGPIPE ignored so child-pipe failures leave the renderer usable.
Private lifecycle records, PTY output and stage timings explain failures;
CI retains the fixture artifacts after a failed run.

Both package typechecks, the SDK suite (2,822 passed; three existing skips),
release parity and CI inventory contracts pass. One read-only Codex Sol review
found the missing artifact collection; its fix has a real red/green regression.

Library catalog entries: `@smthrs/ui`, `@smthrs/terminal-frame`, `@smthrs/flow`,
`@smthrs/targets`.
