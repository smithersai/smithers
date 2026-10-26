# 0104 — Request-owned Worker I/O

Date: 2026-10-25

## Decision

Each Worker request creates and awaits its own I/O. Share completed answers in
Postgres or a storage cache; never retain a pending Effect Cache, Deferred or
memoized Effect in a module or layer for other requests. A local factory is
checked conservatively because layer construction can retain its result.

The deterministic `worker.request-owned-io` ESLint rule bans the known sharing
primitives (including scoped/resource caches and pools), resolves import and local
aliases, and accepts cached literal
constants only. Persisted durable deferred tokens and schema constants remain
safe. This guard does not claim arbitrary interprocedural ownership analysis.

## Evidence and consequences

The production About read shared a `Cache.makeWith` lookup. Node accepted it;
workerd cancelled other requests waiting on the first request's I/O. The new
workerd test exercises thirty cold reads through the bundled production RepoApi
route, real Postgres and GitHub. It rejects the old lookup and accepts the
storage coordination in 4dceac5135fd. Signer construction in RepoRoles and Compare
also runs separately per request: WebCrypto key import must not be awaited from
a shared cached Effect. Catalog entries used: @smthrs/integrations for GitHub,
@smthrs/database PostgresDatabase and @smthrs/targets NodeTest, with Effect
HttpClient. No additional dependency.

## Addendum, 2026-10-25: waiting counts as sharing

`worker/github/ReadToken.ts` kept one `Semaphore.make(1)` per isolate around the
GitHub App read token's mint. A signed-out read of the GitHub shapes that waited
on another request's permit was cancelled as hung: 60 to 600 times an hour in
production since 10-24, hidden by the browser's retries. Effect's own scheduler
notes say why: the waiter's wake-up timer is created in the releasing request,
and workerd drops it when that request ends. So a request never waits on a
permit, latch, queue, pubsub or synchronized ref that another request releases.
The isolate keeps only completed values (the minted token and its expiry in a
plain `Ref`), and a read that finds none fresh mints for itself; a cold isolate
may mint a few tokens at once. `worker.request-owned-io` rejects those
constructors and a `Ref` of pending work. `worker/GitHubShapes.workerd.test.ts`
proves the shapes signed out and signed in under workerd.

