---
title: Stable public live-query snapshots
status: done
area: plugins
owner: Codex GPT-6 Astra
updated: 2026-11-04
links: []
---

Repair the public plugin live-query adapter's React snapshot identity while retaining synchronous access revocation. Trace the introducing revision, prove repeated reads, collection changes and same-read gate denial with real collections, and run the three reported browser specs and the four-project typecheck on the mini.

Library catalog: `@smthrs/effect-tanstack-db` supplies real collections and live queries; `@smthrs/plugin` supplies the public `Host.Live` contract. No plugin-private interface is added.

Cause: `771ed98aed9f` introduced the synchronous `liveQueryOf` read and the repository `gateLive` wrapper after production `cf35e6ae56f3`. TanStack's `toArray` allocates an array for every read, and the hidden wrapper also allocated `[]`. NavCount passes this getter directly to React. Retaining row references after reading the gate synchronously fixes identity without restoring the refused-row exposure that motivated the change.

While validation waited for capacity, `4764eb044cbe` independently landed the synchronous identity fix and `76934ac1be47` froze its arrays. This lane retains both changes and their regression, returns the shared frozen snapshot again when a query empties, and adds four wider behavioral tests in `liveQuerySnapshots.test.ts`.

Consumer audit: queue `NavCount` reads `core/waits` directly; queue `Queue` reads its stored cursor value. Bugs `Inbox` reads the stream-held `core/bug-reports` snapshot, and `Report` reads its stored sending state. Fleet and factory `useWatched` read tab cells updated by subscriptions. Factory's derived waiting list feeds a cell before React reads it. No component needs a private interface or its own workaround.

Validation: the mini red run failed repeated-read identity. The new tests use real collections for insert/update/order/delete, same-stack role/session revocation, hidden snapshots, notifications and unsubscribe. The final nine-file consumer suite passes 36/36 through the authorized remote fallback, including all four new regressions and main's original regression; all four ES2022 typecheck projects pass. The factory consumer tests also exposed outdated exact expectations for opened documents: they now include the repository field added by the data-gate change. Partial-suite coverage is disabled; this is not a full-suite coverage claim. The three reported browser cases passed on the mini, plus setup (4 passed, 43.7s), with matching adapter source hashes. Those browser cases preceded main's incoming visible-array freeze; the final consumer suite and typecheck passed with that protection retained. No deployment was performed.
