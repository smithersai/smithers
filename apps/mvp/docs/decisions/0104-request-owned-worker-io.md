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
