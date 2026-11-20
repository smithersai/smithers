---
title: "The cache"
description: "What Smithers CI caches, when a result is reused, where the cache is on a machine, how to host the cache yourself, and how to point CI at it."
---

A CI runner starts empty. The cache lets a run reuse what an earlier run
proved, on any machine: a step whose files did not change is not run again.

## What is cached

The result of each step that passed. A step is one command of your CI, or one
package's share of a command that runs over a whole workspace (see
[Splitting a step](splitting.md)).

A result is stored only after the step ran held to the files it names. A step
held to its files fails when it reads any other file, so a stored result never
depends on a file the cache did not see.

A step that names no files runs in the open with its reads recorded. Its
result stays on the machine that ran it and is reused there while every file
it read is unchanged. The generated workflow carries those results from one
run to the next with `actions/cache`. It carries the compiled code of Smithers
build the same way, so each run starts sooner than the first.

With each such result it carries what the step left for the steps after it,
in its job's checkout and home. When a later step of the job has to run and
this one is reused, those files are put back and the later step finds what it
would have found on a runner. A step's own files are never put back for the
step itself. They include what a tool wrote in its own cache while the step
ran: a step that runs `go test` in a Go module with no dependencies leaves
about 58 MB, most of it the standard library `go` compiled.

The cache never holds:

- **A failed step.** It runs again.
- **A step fast mode skipped.** It did not run, so it has no result. It is
  reported as skipped and never becomes a cache hit.
- **A secret's value.** Smithers CI records the secrets a CI step uses by name
  only.
- **A tool's own cache.** Go, Zig, npm and Cargo each keep a cache in the home
  directory or beside the build file. Each stays where its tool puts it, in
  the step's own job: empty when the job starts and gone when it ends, as on
  a runner. A step that runs so builds and tests for real. What your CI saves
  itself, with a cache step or a setup action, is there at the next run, as on
  GitHub: see [Caches](github-actions.md#caches).

## When a result is reused

Every step has a key: a hash of its command, its environment, the tools that
run it (the Node.js version, the operating system and the version of Smithers
build) and the content of each file it reads. A run looks each step's key up,
first on its own machine, then in the cache. An equal key means an equal
verdict, so the stored result is taken and the step is reported as `hit`.

Change one file and only the steps that read it get a new key. They run; every
other step is still a hit. The time of day is never part of a key. The commit
is part of it only for a step whose command uses the commit.

Two machines share results when they run the same tools on the same operating
system.

## Where the cache is on a machine

Never in your checkout. A step that checks its tree, with
`git status --porcelain --ignored`, `git clean -ndx`, `find` or `ls`, finds
your repository's files and nothing of Smithers CI's. `apply` adds no line to
your `.gitignore`, because there is nothing to ignore.

| Where it runs                           | The cache directory                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The generated workflow, on a runner     | `smithers-ci` in the runner's temporary directory. `actions/cache` saves it when a job ends and restores it at the next.             |
| `smthrs ci '//...'` on your own machine | A directory named after the repository in your user cache directory: `~/.cache/smithers/`, or `~/Library/Caches/smithers/` on macOS. |
| `smithers-ci` and `smithers-ci replay`  | A temporary directory beside the copies the replay runs in. The replay removes it when it ends.                                      |

On Linux `XDG_CACHE_HOME` moves the user cache directory, as it does for every
program that reads it. Each checkout has a directory of its own, so two clones
of one repository never share a result by accident.

To see the directory a checkout uses and how much it holds:

```bash
smthrs cache status
```

To clear it:

```bash
smthrs cache clear
```

The next run starts cold and fills it again. Deleting the directory does the
same. To keep the cache somewhere else for one run, name the directory:

```bash
smthrs ci '//...' --cache-dir /mnt/fast/smithers-ci
```

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
`curl http://127.0.0.1:8080/healthz` prints `{"ok":true}`.

`DATABASE_URL` is the database's connection string. Add a user and a password
to it when your Postgres asks for them.

The cache has two tokens. The read token reuses results. The write token also
stores them. They must differ and be at least 16 characters; the service does
not start with one token or with two equal ones. Any other token is refused
with `401`, and the read token is refused with `403` when it tries to store.
The service also does not start while `SMITHERS_CACHE_TOKEN` is set in its own
environment: that name belongs to the runs that use the cache.

A run on another machine talks to the cache over HTTPS only, so put the
service behind an HTTPS proxy. With [Caddy](https://caddyserver.com), which
gets the certificate itself:

```sh
caddy reverse-proxy --from cache.example.com --to 127.0.0.1:8080
```

Plain HTTP is accepted only for a cache on the same machine, at `localhost`,
`127.0.0.1` or `[::1]`, which is enough to try the cache on one machine.

The same service and database also run in Docker: see the
[self-hosted stack](../../../smithers/build/docs/workspace/remote-caching.md#self-hosted-stack).

## Point CI at the cache

The workflow `smithers-ci apply` writes reads three settings of your GitHub
repository:

| Setting                     | Kind     | Value                     |
| --------------------------- | -------- | ------------------------- |
| `SMITHERS_CACHE_URL`        | Variable | The cache's URL.          |
| `SMITHERS_CACHE_TOKEN`      | Secret   | The write token.          |
| `SMITHERS_CACHE_READ_TOKEN` | Secret   | The read token. Optional. |

With the read token set, a pull request reuses results and stores none.
Without it, a pull request from a branch of the repository is given the write
token and stores results too.

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

The URL is `https://`, with no user name, password, query or fragment. The
workflow is a file you commit, so `apply` refuses a URL with a user name or a
password with exit 2. A token is never printed or written to a file.

A cache is never required. A cache that is down, or that refuses the token,
never fails a run:

| The run has                  | What it does                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------- |
| No URL                       | Runs every step and prints `No shared cache, so results stay on this runner.` |
| A URL and no token           | Runs every step and prints `remote cache off: no credentials`.                |
| A token the cache refuses    | Prints a warning that names `HTTP 401`, then runs every step.                 |
| A cache that does not answer | Prints a warning, then runs every step.                                       |

GitHub gives a pull request from a fork no secrets, so it runs without the
cache.

### Who can read a token

A token is a secret of the job, and the steps of the job are your repository's
code. What keeps a step from the token depends on the runner:

- **Linux.** A step cannot read the token from another process. `smthrs` runs
  the steps where they see no process but their own and where `sudo` gains no
  privilege. The workflow installs bubblewrap for this.
- **Linux with a container daemon the step can reach**, as on a GitHub
  runner. A step that talks to the daemon can have it read any process of the
  machine, the token with it.
- **macOS and Windows.** A step can read the token from the program that runs
  it.
- **Linux without bubblewrap, or as `root`.** A step can read the token.

So give each run the least it needs:

- The read token reuses results and stores none. A step that reads it can
  fetch what your CI has stored.
- The write token also stores results. A step that reads it can store a
  result that later runs reuse, a wrong one included.
- Set `SMITHERS_CACHE_READ_TOKEN`. A pull request then never holds the write
  token, on any runner.
- A pull request from a fork is given no token.

A token opens the cache and nothing else. It is not a GitHub token and reaches
no other service.

A URL that can never work is a mistake to fix, not a cache that is down: a
run given a URL that is not HTTPS, or one with a query, stops before its first
step and says why.

`smithers-ci` and `smithers-ci replay` take the same URL, with the token in
the `SMITHERS_CACHE_TOKEN` environment variable:

```sh
bunx smithers-ci --cache https://cache.example.com
bunx smithers-ci replay --cache https://cache.example.com
```

## Across machines

The workflow `smithers-ci apply` writes has one job per machine your CI names
in `runs-on`. Each job checks out the repository and runs the targets for that
machine's operating system. When your CI asks for several versions of a tool,
each machine gets one job per set of versions, and each of those jobs runs the
targets of its set.

Each job keeps its own results between runs with `actions/cache`. Jobs share
results only through the cache: with `SMITHERS_CACHE_URL` set, a job reuses what
another job stored.

`smithers-ci` and `smithers-ci replay` run every target on the machine you run
them on.

## See also

- [How it works](how-it-works.md)
- [Remote caching in Smithers build](../../../smithers/build/docs/workspace/remote-caching.md)
