# 0169 — Smithers CI restructures a repository, and the cache gets an admin token

Date: 2026-11-19. Status: accepted (Will's words in chat; rulings SCI-1 to SCI-12).
Nothing in this record is built yet except where "Today" says so.

## Context

Smithers CI (`packages/ci`) reads the CI a repository has and turns each step
into a cached target. On `refcell/needlefish` that gave two targets, `tidy` and
`zig build test`. The second holds 3,180 tests in one binary, so any edit under
`src/` reran all of them: caching a monolith does not make it incremental.

Measured on needlefish on 2026-11-19 (16-core Mac, Zig 0.17.1, empty cache):
927 s for `just ci`, of which 720 s is the one test binary running on one core.
With every folder a Zig module and a test binary per package, the same 3,348
tests took 327 s, and an edit to a leaf package reran 6 of 116 binaries in
50 s. An edit to `common/rlp` still reran 75, because 72 of the folders import
each other in a cycle.

## Decision

1. Smithers CI changes the repository, not only its CI file: it splits the
   build into packages, removes import cycles and makes every target's files
   explicit, as a stack of single reviewable commits (SCI-1, SCI-5, SCI-7).
2. One strategy per language, run as an agent workflow, built on the
   language's own incremental build: TypeScript and Zig (SCI-2).
3. Per target it chooses between a rebuild, the local cache and the remote
   cache by measured time (SCI-3).
4. The run is visible while it happens: the graph of today's CI, the planned
   commits as pending, the contracts that let them be made in parallel, and
   each measurement (SCI-4, SCI-6).
5. The cache is local first and syncs through a remote cache on Cloudflare,
   deployed by Alchemy (SCI-8).
6. The remote cache has read, write and admin tokens, and only the admin
   token issues read and write tokens (SCI-9).

## Today

| Part                                   | State                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Local-first lookup, then remote        | Built. A run looks a key up on its machine, then in the cache.             |
| Remote cache on Cloudflare by Alchemy  | Built: `packages/smithers/build/infra`, a Worker with D1 and R2.           |
| Read and write tokens                  | Built, as two secrets set at deploy time. See `infra/CACHE-TRUST.md`.      |
| Admin token that issues the other two  | Not built. Tokens are fixed per deployment; there is no issuing endpoint.  |
| A Zig step's result in the remote cache | Not built. A Zig step names no files, so its result stays on its machine. |
| The improver (points 1 to 4)           | Not built. A hand-run prototype exists for needlefish only.                |

## What this replaces

Nothing is withdrawn. `CACHE-TRUST.md` keeps its rule that readers are
untrusted and writers are trusted; the admin token adds who may create a
reader or a writer.
