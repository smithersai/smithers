---
title: "The cache"
description: "What Smithers CI caches, when a result is reused, how to host the cache yourself, and how to point CI at it."
---

A CI runner starts empty. The cache lets a run reuse what an earlier run
proved, on any machine: a step whose files did not change is not run again.

## What is cached

The result of each step that passed. A step is one command of your CI, or one
package's share of a command that runs over a whole workspace (see
[Splitting a step](splitting.md)).

A result is stored only after the step ran held to the files it names. A step
held to its files fails when it reads any other file, so a stored result never
depends on a file the cache did not see. A step that may read any file still
has its result kept on the machine that ran it; the generated workflow carries
those from one run to the next with `actions/cache`. It carries the compiled
code of Smithers build the same way, so each run starts sooner than the first.

The cache never holds:

- **A failed step.** It runs again.
- **A step fast mode skipped.** It did not run, so it has no result. It is
  reported as skipped and never becomes a cache hit.
- **A secret's value.** Smithers CI records the secrets a CI step uses by name
  only.

## When a result is reused

Every step has a key: a hash of its command and of the content of each file it
reads. A run looks each step's key up, first on its own machine, then in the
cache. An equal key means an equal verdict, so the stored result is taken and
the step is reported as `hit`.

Change one file and only the steps that read it get a new key. They run; every
other step is still a hit. The time of day and the commit are not part of a
key.

## Host the cache

The cache is one small HTTP service and a Postgres database. Both are in the
Smithers repository. You need [Bun](https://bun.sh) 1.4 or later and Postgres.

```sh
git clone https://github.com/smithersai/smithers
cd smithers

createdb smithers_cache
psql -d smithers_cache -f packages/smithers/build/terraform/modules/cache/migrations/0001_initial.sql

export SMITHERS_CACHE_READ_TOKEN="$(openssl rand -hex 32)"
export SMITHERS_CACHE_WRITE_TOKEN="$(openssl rand -hex 32)"
DATABASE_URL=postgres://localhost/smithers_cache PORT=8080 \
  bun packages/smithers/build/terraform/modules/cache/service/server.js
```

It prints `smithers build cache listening on 0.0.0.0:8080`, and
`curl http://127.0.0.1:8080/healthz` answers `200`.

The cache has two tokens. The read token reuses results. The write token also
stores them. They must differ and be at least 16 characters; the service does
not start with one token or with two equal ones. Any other token is refused
with `401`, and the read token is refused with `403` when it tries to store.

A run on another machine talks to the cache over HTTPS only, so put the
service behind an HTTPS proxy. With [Caddy](https://caddyserver.com), which
gets the certificate itself:

```sh
caddy reverse-proxy --from cache.example.com --to 127.0.0.1:8080
```

Plain HTTP is accepted for `localhost` and `127.0.0.1`, which is enough to
try the cache on one machine.

The same service and database also run in Docker: see the
[self-hosted stack](../../../smithers/build/docs/workspace/remote-caching.md#self-hosted-stack).

## Point CI at the cache

The workflow `smithers-ci apply` writes reads three settings of your GitHub
repository:

| Setting                     | Kind     | Value                                                                 |
| --------------------------- | -------- | --------------------------------------------------------------------- |
| `SMITHERS_CACHE_URL`        | Variable | The cache's URL.                                                      |
| `SMITHERS_CACHE_TOKEN`      | Secret   | The write token.                                                      |
| `SMITHERS_CACHE_READ_TOKEN` | Secret   | Optional. The read token: pull requests reuse results and store none. |

```sh
gh variable set SMITHERS_CACHE_URL --body https://cache.example.com
gh secret set SMITHERS_CACHE_TOKEN
gh secret set SMITHERS_CACHE_READ_TOKEN
```

`--cache` writes a URL into the workflow, which is used until the variable is
set:

```sh
bunx smithers-ci apply --cache https://cache.example.com
```

The URL holds no credential. The workflow is a file you commit, so a URL with
a user name or a password is refused with exit 2. A token is never printed or
written to a file.

A cache is never required, and a cache problem never fails a run:

| The run has                  | What it does                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------- |
| No URL                       | Runs every step and prints `No shared cache, so results stay on this runner.` |
| A URL and no token           | Runs every step and prints `remote cache off: no credentials`.                |
| A token the cache refuses    | Prints one warning that names `HTTP 401`, then runs every step.               |
| A cache that does not answer | Prints one warning, then runs every step.                                     |

GitHub gives a pull request from a fork no secrets, so it runs without the
cache.

`smithers-ci` and `smithers-ci replay` take the same URL, with the token in
the `SMITHERS_CACHE_TOKEN` environment variable:

```sh
bunx smithers-ci --cache https://cache.example.com
bunx smithers-ci replay --cache https://cache.example.com
```

## Across machines

One run can be divided across machines. Every machine computes the same plan
and takes the steps whose name hashes to its index, so the machines agree on
the split without talking to each other. A machine runs its own steps and
anything they depend on that is not already a cache hit. Machines share
results only through the cache.

## See also

- [How it works](how-it-works.md)
- [Remote caching in Smithers build](../../../smithers/build/docs/workspace/remote-caching.md)
