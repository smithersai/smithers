# 0152 · A cold issue page paints before the app boots

2026-11-02 · Accepted. Builds step 4 of [0151](0151-every-session-end-wipes-the-device.md)'s rollout (the device-privacy
design's §3.10, "First paint: an uninterrupted lock hold") ahead of its step 3, as an early slice approved for Will's
cold-load priority. [issues.md#first-paint](../features/issues.md#first-paint) says how it works.

## Why

Measured on production's API with a local bundle (3 cold rounds per page, 2026-11-02): a cold issues list showed its
first rows at 7.0-14.4 s and an issue page its title at 4.5-6.3 s. The app renders only after the device store opens
(`boot.services` at 2.0-2.3 s), and each issue shape waits for its own collection's restore, which queues behind 46-72
other restores (1,000-1,400 SQLite requests). Neither the `/role` read nor the session reads were on the critical path.
No change to that chain alone reaches the targets (list first rows by 2 s, issue title by 3.5 s), because rendering
starts after 2 s.

## Rule

1. **A public shell, a private answer.** `index.html` stays the same bytes for everyone. Its inline script reads
   `GET /api/repos/<owner>/<name>/first-paint` with the cookie: an issue's number, title, state and author, or the
   list's first 30 issues. The server answers it under the shapes' rule (`repositoryReadable`, viewer source `cookie`),
   `private, no-store`, and every outcome but a paint is an empty `204`.
2. **Inside the data lock, in memory only.** The shell reads only under a shared `smithers-data` hold taken before the
   read and with sign-out's wipe mark absent before and after the grant. The answer lives in the shell's memory and one
   DOM node, never in any store or cache.
3. **It never outlives the session the page would show.** It goes on a wipe message, the mark, `pagehide`, the session's
   deadline (`sentAt + (expiresAt - serverNow)`, both from Postgres in the session's own lookup, so a Worker clock
   skewed from Postgres moves nothing), 30 s without a hand-over, or the page's first session answer naming anyone
   else. A hidden or frozen page hides it; shown again, it checks those first.
4. **Hand-over without a gap.** The app's boot adopts the shell's hold as its own (`PageWipe.open(adopted)`), and
   letting go of it ends the paint first. The node goes once the page shows itself or why it can't, and an answer
   arriving after that is never painted.
5. **It never blocks a person.** It covers the empty page only until the app renders anything to act on, then sits in
   the page's flow, in a slot the page leaves for it. The first build kept it over the page until the list's whole
   sync finished: 15-25 s on 4,360 issues, with rows and search hidden under it, and proof (a)'s search at 7.5 s
   against its 5 s budget.

## Why this is safe before step 3

0151 step 3 (the latch, permit and wipe on every session end) isn't built, so today only sign-out wipes. The first paint
honours sign-out exactly as §3.10 requires: the mark, the lock and the channel are today's (src/wipe.ts). For the ends
step 3 will add, the first paint is no weaker than today's page. Expiry is the deadline. Revocation, or another person
signing in, is the page's first session answer, read within about 2 s of boot. Until then the paint holds only what the
server just authorized for the cookie it was sent with. When step 3 lands, its latch revokes the node with the rest of
the DOM.

## Rejected

Rendering the app on the server (the document would become private, and the service worker answers navigations from
the precached shell anyway); keeping the answer on the device for a faster reload (a new private cache); reordering the
restores (measured before: no gain).

## 2026-11-04: an issue read after a missed shell paint

The issue route starts `issues?q=%23N` before opening its collections. This reuses
the list search client's deadline, in-memory answer, generation fencing and
`RepoStore.gate`; nothing waits for Electric to render a known heading. Since
search also matches titles, the direct read follows cursors until it finds the
exact number or exhausts the results, under one deadline. The shell's deliberately
short, empty-on-failure first-paint contract stays intact.

The route result is retained only after this device establishes allowed repository
authority and restores refusals; a failed summary transport cannot discard it.
It never supplies a body or comments, and synced detail remains authoritative.
A pending or failed read shows the requested issue number, without skeletons or
"Syncing issue…". A known absence and a refusal keep their real page states.
List navigation restores its URL search if a direct read replaced the retained
answer, fencing late issue responses so browser Back cannot strand the list.
An issue result survives list sync; detail failures keep the authorized heading
alongside their unavailable state and Try again action.

The separate WebKit list failure came from treating the unrelated About flow's
failure as issue unavailability. That settled the list and removed authorized
first paint while its own shape still waited. Only repository authority and the
issue transport now decide list availability. Existing `repo.about.load`,
`repo.role` and `issues.shape.sync` records identify those independent stages.

`issues.read` spans, `issues.search` logs and `smithers_issue_reads` counts
distinguish direct issue reads from list searches without query or content.
This repairs existing navigation and issue presentation infrastructure, not a
new feature or plugin. Catalog entries used: `@smthrs/ui` for the heading,
`@smthrs/effect-tanstack-db` for the existing gated in-memory result, and the
existing Effect HTTP issues client. No new runtime or cache.


## Search before global startup (2026-11-04)

The list's shell accepts search text before React mounts. The browser's existing issues client is built below the
store and service startup chain; its read waits for device identity as every app API read does, but not for SQLite
preparation or restored drafts. TanStack Router owns the query URL. The shell drops its unfiltered rows as soon as
text changes. A separate publisher follows the existing data gate before passing it any search rows.
The gate exposes synchronous boolean decisions through its observer API; the publisher never reads its raw collection.

One transient, bounded response serves the early gated paint and is consumed once by the ordinary search action.
The early publisher waits for restored refusals and follows the existing gate synchronously; a changed refusal fence
or a closed gate revokes the answer permanently. Once refusals are known, the publisher observes the gate before
joining the HTTP body, so a close-and-reopen during a delayed body cannot revive it. A normal consumer that already
claimed that revoked answer discards it too and makes its own fresh authorized read. Expiry, replacement and publisher
teardown revoke the same entry even after consumption; the consumer rechecks its generation after the body joins. The ordinary action still waits for repository authority and lets
synced rows win. Applying authoritative summaries withdraws the early answer, and the shell gives way to the settled
view when it has rows, an answer to this repository and query (including zero matches), or complete sync. A query
without an answer does not mark an empty view settled and discard the gated shell. Restoring refusal marks is
an authorization dependency and is deliberately retained. No response is inserted into any collection by this early
reader. A replacement query, navigation, wipe, changed viewer, expiry, or closing the app revokes an unconsumed read;
it also expires after 15 seconds. The bridge changes no transaction or durable acknowledgment.

The HTTP read overlaps device storage and draft/outbox startup. Those local writes retain their existing independence
from repository restoration. Authority starts before repository metadata and branch conversations; store construction
does not await refusal restoration. The publisher alone waits for the gate, while other feature services may start.
The same refusal collection, restore follower, closed gate, statements and commit acknowledgments are used. A failed
restore still leaves private rows hidden while local drafts remain writable, and in-memory stores construct synchronously.
The route starts each search once; the public input only changes its URL. No cold-list loading label is rendered.

This belongs to the existing first-paint core boundary because it runs before the plugin host exists. It uses the
existing issues HTTP client and the catalog's persisted-collection/data-gate libraries (`@smthrs/effect-tanstack-db`),
not a second issues store. `issues.search.early` and `issues_early_search_reads` record duration and outcome without
search text. `issues.search.paint` and `issues_early_search_paints` record gate decisions. The shell marks when it accepted input on the boot timeline.
