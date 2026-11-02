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
