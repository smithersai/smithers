---
title: Restore local browser tests
status: done
area: infrastructure
owner: Codex mini-e2e
updated: 2026-10-25
links: [../infrastructure.md]
---

Alchemy's local provider strips the deferred VibeLang build plugin before the Worker watcher receives it. Preserve build options in local diff and reconcile, and exercise the real watcher against the developer Worker.

The RPC codec also discards plugin functions. WorkerBuild now carries a deferred module reference that the Alchemy patch rehydrates. The VibeLang loader template also needs a split source-map directive so Playwright does not parse the loader itself as a map. Latitude: five bundle/loader tests pass and one existing test is expected to fail; app typecheck and import rules pass. The mini runner passes all three slash-command browser tests (57.5 seconds), with the developer session ready after 22.4 seconds. The runner exits 0.
