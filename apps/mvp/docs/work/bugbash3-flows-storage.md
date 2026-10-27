---
title: Flow editor storage diagnostics
status: blocked
area: flows
owner: bb2-webkit
updated: 2026-10-27
links: []
---

W12 owner bb2-webkit: root cause reproduced on a local production build. WebKit
evaluated the worker entry twice through the engine chunk's import back-edge.
Effect Schema then mixed private sentinels and encoded the preparation result's
finite epoch as "Symbol()", producing SchemaError and PrepareFailed. SDK worker
composition now uses static imports. Preparation uses a v2 execution identity so
an old terminal failure does not keep a repaired device fenced.

Private WebKit's OPFS refusal now leaves an editable session form with "Not kept
on this device". Decision 0118 updates 0092. PendingSnapshot stages the form at the
input boundary until its SQLite receipt; Chromium and WebKit keep both fields
across an immediate reload in the local built-app smoke. Private WebKit edits both
fields and enables Draft. A durable action still requires an available engine.

Catalog: @smthrs/platform-browser for worker composition and pending snapshots;
@smthrs/effect-tanstack-db for existing persistent/memory collections. No new dependency.

SDK: 384 tests pass at 100% in all four coverage metrics; typecheck, source
ESLint and changed-file formatting pass. Full package lint retains pre-existing
formatter failures in BrowserLanguageServer.ts and BrowserRuntime.test.ts.
The dedicated-worker cached-binary regression passes Chromium and WebKit.
The focused app suite passes 74 tests at 100% for boot and the changed editor
modules. App typecheck, importRules, lint and production build pass on Latitude.

The offline follow-up found a second cause: worker-native asset loads bypass the
page's service worker, and the shell precache omitted WASM. The SDK now exposes
Effect-owned cached binary loading and bundles SQLite's API/VFS; the app binds
the factory statically and precaches WASM. A fresh persistent WebKit profile on the final production build passes a real
server shutdown: cached shell, prepared engine, both unfinished fields retained
after reload, and no session-only warning.

Read-only production run: 2 pass (chat shortcut and Chromium editor), 5 fail
(WebKit outbox, conversation reload, editor, private editor and repository direct
visit). The deployed build still has SchemaError/PrepareFailed. Local full E2E
also ran, but its console watcher rejects background POSTs denied by the strict
read-only API proxy. These runs are not green feature proof. Playwright WebKit's
setOffline prevents even cached document navigation; separate real server
shutdown probes distinguish that harness fault from app storage failures.

Remaining: deploy through the lander, then rerun the storage, chat/outbox,
conversations and repository browser suites against the repaired backend/build.
Private session input is usable; durable actions still require the device engine.
