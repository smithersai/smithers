---
title: Fast Smithers CI (customer zero for smithers-ci)
status: in-progress
area: build
owner: Claude Fable, Will's chat session 20474551, since 2026-11-17 16:50 PST
updated: 2026-11-18 07:20 PST
links: [ci-cd-parity.md, ci-parity-cache.md, second-build-machine.md, release-burn-down.md, ../../../../packages/smithers/build/docs/workspace/caching.md, ../../../../packages/smithers/build/docs/workspace/adoption.md]
---

## What

Make Smithers' own CI fast with Smithers build, then ship the same thing to
other repositories as `smithers-ci`.

## Why

Will, 2026-11-17: "our ci became a major bottleneck"; it "caused us to miss a
release deadline"; "the mvp I believe we can ship this week and makes the
biggest impact is perfecting and polishing smithers ci/cd." A coding factory is
codegen and automations built as Smithers workflows on top of fast CI.

## Finish line

1. `smthrs ci //packages/...` on an unchanged tree: every target is a cache hit,
   under 2 minutes.
2. A one-file change reruns only the targets that depend on it.
3. A replay of the last 20 `main` commits gives the same pass or fail per
   target with the cache on and off.

Item 3 is the acceptance evidence
[#1871](https://github.com/smithersai/smithers/issues/1871) asks for, and the
demo `smithers-ci` shows a stranger.

## Measured baseline

Source: the "Workspace targets" gate of the rc.18 rehearsal, Thursday
2026-11-12, release commit `2649581d7eac`
(`~/Desktop/smithers-rc18/thursday-gate-results/workspace-targets.json`). Not
re-measured on today's `main`.

721 targets, 5.4 hours of work, 0 cache hits, 22 failed, 7 skipped. One machine
ran them one after another.

| Target name | Targets | Minutes | Share |
| --- | ---: | ---: | ---: |
| `test` | 64 | 225.3 | 69.6% |
| `lint` | 64 | 15.9 | 4.9% |
| `bunTest` | 12 | 10.8 | 3.3% |
| `check` | 71 | 9.9 | 3.1% |
| `lib` | 61 | 7.0 | 2.2% |
| `fmt` | 64 | 2.2 | 0.7% |

Five `test` targets take 128.7 minutes, 40% of all the work:

| Minutes | Target |
| ---: | --- |
| 40.1 | `//packages/smithers:test` |
| 36.6 | `//packages/smithers/build/build-cli:test` |
| 20.0 | `//packages/smithers/flows/engine-store:test` |
| 16.7 | `//packages/smithers/agent:test` |
| 15.3 | `//packages/lemmascript:test` |

What the numbers say:

- Tests are 70% of the time. Caching test results matters most; formatting is
  under 1% and can wait.
- The longest single target is 40 minutes. Run on enough machines, the whole
  graph takes 40 minutes, not 5.4 hours, with no cache at all.
- A 40-minute target reruns whole when any file in its package changes. The
  five large `test` targets must be split before a cache helps them.

## Census of cache reuse, 2026-11-17

Finish line 1 is not met. On an unchanged tree, the third run of CI's workspace
graph took 63.5 minutes against the 2-minute goal, and 327 of 734 targets hit.

Commit `a700ffcfc5ff`, the 77 patterns of CI's "Workspace targets" step with no
shard, `--jobs 15`, an empty cache at the start. nyc-01 was shared with other
work (load 20 to 270) and has no Docker.

| Run | Tree | Wall | Hit | Ran | Failed | Skipped |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Fresh install, empty cache | 43.6 min | 0 | 670 | 49 | 15 |
| 2 | Unchanged after run 1 | 50.0 min | 182 | 475 | 61 | 16 |
| 3 | Unchanged after run 2 | 63.5 min | 327 | 316 | 68 | 23 |

Run 2 is not a fair second run. The first `dprint` start links its binary into
`node_modules/.pnpm/dprint@0.57.1`. That changes the root `node_modules` digest
and 548 of 734 keys. Run 3 is the second run on a settled tree.

Run 3 by reason. Minutes are each target's own time, taken from a fourth run
without the two exclusive `Shell.Diff` targets, because the run record's time
includes queueing behind them.

| Reason | Targets | Minutes |
| --- | ---: | ---: |
| Hit | 327 | 0.8 |
| Ran: the confined run needed an undeclared read | 150 | 94.0 |
| Ran: the confined run failed, no path named | 34 | 23.2 |
| Ran: the rule or declaration is never cached | 130 | 21.8 |
| Ran: other | 2 | 4.3 |
| Failed: never passed in four runs | 38 | 193.0 |
| Failed: passed in another run | 15 | 74.3 |
| Failed: lint reads `*.d.vibe.ts` files run 1 left | 9 | 5.9 |
| Failed: needs Docker, did not start | 6 | 0 |
| Skipped: a dependency failed | 23 | 0 |

Undeclared reads that block the most minutes. A target counts under every read
its failure names, and only 52 of the 150 name a single read, so declaring one
read rarely frees a target.

| Read | Targets | Minutes |
| --- | ---: | ---: |
| `packages/smithers/flows/flow` | 46 | 29.3 |
| `packages/smithers/flows/journal` | 29 | 23.2 |
| `packages/smithers/flows/database` | 31 | 20.5 |
| `packages/smithers/flows/canonical` | 26 | 16.8 |
| `packages/smithers/flows/plan` | 28 | 16.2 |
| `packages/smithers/flows/kernel` | 19 | 15.5 |
| `packages/smithers/flows/crypto` | 21 | 13.3 |
| `packages/smithers/flows/engine` | 13 | 12.5 |
| `packages/smithers/agent/model` | 15 | 12.2 |
| `packages/smithers/control` | 11 | 10.4 |

## Order of work

Superseded on 2026-11-17 by the one-wave build below; kept as the order the join is checked in.

1. Replay harness: run N commits with the cache on and off and compare each
   target's verdict.
2. Cacheable `test` targets under the enforced sandbox, proved by the replay.
3. Split the five large `test` targets.
4. Run targets across machines, so wall time is the longest target.
5. Cacheable `check`, `lib` and `lint`.
6. `smithers-ci`: the same replay as a read-only report on another repository.

## The product, built splash page first

Will, 2026-11-17: "I do end user driven development for products." The order is
the splash page, then the docs, then tests and the public API from the docs,
then the implementation. One piece at a time.

Smithers CI is the first step toward Smithers Cloud, the hosted service that
replaces GitHub Actions, and toward coding factories such as
`vibelang.smithers.sh`.

| Piece | State |
| --- | --- |
| Name | Smithers CI; `bunx smithers-ci`; `ci.smithers.sh`. Proposed by the agent, not objected to |
| Eyebrow | "Fast CI for agents" (Will, 2026-11-18) |
| Tagline | Open |
| Buttons, install command, stats | Not started |

## The first repositories (Will, 2026-11-17)

Will: "once we get going we are going to use this on many repos. So we will be
using it on refcell/needlefish. And we will be using it on elizaOS/eliza
vibelang and smithers."

| Repository | What it is | What it needs from us |
| --- | --- | --- |
| Smithers | TypeScript, pnpm, CI generated by Smithers build | Cached test targets, shards |
| VibeLang | Ours; runs on Smithers build | A published Smithers build |
| `refcell/needlefish` | Zig, a `Justfile`, no GitHub workflows | Reading a Justfile; a Zig strategy for what a change reaches |
| `elizaOS/eliza` | TypeScript, Bun, Turborepo, about 40 workflows, 2 GB | Bun installs, which Smithers build refuses today |

Checked with the GitHub API on 2026-11-17. So the inventory names shell
commands, not tools, and reads Justfiles and `turbo.json` as well as GitHub
workflows.

## What a change reaches, one strategy per language (Will, 2026-11-17)

Will: "Every language is it's own snowflake that we need to describe a
strategy for figuring out affected. Some things like vitest or bun or zig test
etc. might have built in ways or 3rd party reference code of how to do it
anytime we need to do that it shoudl be a fable agent designing documenting
implementing and testing it as it requires judgement."

The TypeScript import closure exists (`build-cli` `Resolver`, and
`RspackRunner` for a bundler's module graph). Each language adds a strategy
that returns the same shape, contract 9. Fast mode reads the same closure for
its graph-distance feature. A Fable agent designs, documents, builds and tests
each strategy.

## The build: contracts first, then one wave

Will, 2026-11-17: "We should be able to clearly define any and all contracts
so we can build everything in parallel. I call this a depth 0 buildout."

The contracts are in the `smithers-ci` package, `packages/ci/src/contract`,
with example documents and tests; `packages/ci/README.md` lists them. They
landed as `1dce256a6c09` and `4bf1ce8a311b`.

Thirteen lanes started at 19:30 PST on 2026-11-17. Each has a brief with its
own finish line at `~/.vibe-orch/live/lanes/<lane>.task.md` and writes
`<lane>.REPORT.md` beside it. Will asked for Opus on simple tasks and Fable on
the ones that need judgement, on the Claude accounts that reset soonest first.

| Lane | Model | Builds |
| --- | --- | --- |
| `sci-cache-tests` | Fable | Test results that can be reused safely (#1871) |
| `sci-closure-vitest` | Fable | Rerun only the test files a change reaches |
| `sci-closure-zig` | Fable | The Zig strategy, for needlefish |
| `sci-select` | Fable | Fast mode's scorer and its eval |
| `sci-bun-install` | Fable | Bun installs, for eliza |
| `sci-replay` | Opus | The replay and its report document |
| `sci-inventory` | Opus | Reading a repository's CI |
| `sci-generate` | Opus | Writing Smithers targets from an inventory |
| `sci-report` | Opus | The report in a terminal and as a page |
| `sci-cli` | Opus | The `smithers-ci` program |
| `sci-shard` | Opus | One run across many machines |
| `sci-docs` | Opus | The docs and a splash page draft |
| `sci-generated-package-targets` | Opus | A defect: a generated package got no targets |
| `sci-decompose` | Fable | Splitting a CI step into per-package steps (added 20:40) |

### What the first two hours showed (2026-11-17, 19:30 to 20:40 PST)

- The contracts changed four times at the lanes' request; `packages/ci/README.md` lists each round. There are
  eleven now: contract 11, the target map, says which target each CI step became.
- Report and docs lanes finished. The reader, generator, fast-mode scorer and program each landed a first version.
- `smithers-ci inventory` reads both outside repositories in under 5 seconds:

  | Repository | Jobs read | Of which a change triggers |
  | --- | --- | --- |
  | `refcell/needlefish` | 22 Justfile recipes | none; `just ci` needs `tidy` and `test` |
  | `elizaOS/eliza` | 1,897 (143 workflow jobs, 1,649 package scripts, 105 Turborepo tasks) | 15 workflow jobs |

- **Only CI is ever run.** eliza's inventory holds scripts such as `db:cloud:migrate` and `ios:device:deploy`, and
  needlefish's holds `clean` and a Docker recipe. `Inventory.ci` narrows an inventory to what a push, pull request
  or merge group triggers, or else the root `ci` recipe. A repository with neither is refused, not guessed at.
- **One target per CI step measures nothing.** A step such as `turbo run test` reads the whole repository, so every
  change reruns it. The splitter (`sci-decompose`) turns it into one step per package with declared inputs, and the
  replay compares a step with the combined verdict of its targets.
- Generated targets run one at a time for now: they share one working tree. The gain on an outside repository is
  from caching, not from parallel jobs.

### The join: first runs of the whole program (2026-11-17 20:40 to 2026-11-18 00:25 PST)

The parts are joined on `main` (`ac588de183f2`): `smithers-ci` reads the CI, generates targets, replays commits and
reports, as one program run from a clone. Three more contract rounds landed (five to seven); the list is in
`packages/ci/README.md`.

- **A job that cannot be reproduced exactly is never run.** Only checkout, cache and artifact-upload actions and
  trigger filters are harmless; any other unsupported feature leaves the job out, with every job that needs it. The
  report lists what was left out, so a speedup is never read as covering it. The type system enforces it: the
  generator and the replay accept only what `Inventory.ci` returns.
- **A replay says what it is running** (`2/5 3f2a1c9 baseline` on standard error). Before, a 25-minute run printed
  nothing.

| Repository | Result | Evidence on nyc-01 |
| --- | --- | --- |
| Fixture, 4 commits (one docs-only, one that breaks a check) | Works: 0 mismatches, the broken commit fails in both modes. Speedup 0.02: starting `smthrs` costs 6 s per commit against 0.1 s of work, and the docs-only commit reran all 3 targets | `~/ci/w0-scratch/fx.json` |
| `elizaOS/eliza` | Refused in 6 s (exit 3): 0 of 15 CI jobs can be reproduced. Blockers: condition 13 jobs, action 11, expression 9, runner variable 8 | `~/ci/w0-scratch/eliza.err` |
| `refcell/needlefish` | Works: `just ci` replayed on 1 commit with 0 mismatches. 36 min 11 s as CI, 31 min 54 s as targets on a cold cache (3,180 Zig tests in one step). A 5-commit replay started 00:14 on Nov 18 and takes about 6 hours | `~/ci/w0-scratch/needlefish.json`, `needlefish5.json` |
| Smithers | Works on its own targets (`a700ffcfc5ff`): never converted; a replay runs a cold `smthrs ci` against a cached one. First trial, 2 commits of `//packages/ci/...`: 0 mismatches, 0.92x, both commits changed the package. `--targets` names the patterns (`e8dd0c0f938c`) | `sci-native` lane report |
| VibeLang | Not yet: its pinned `smthrs` (rc.16) ran `ci //... --plan` for 9 minutes without output | `sci-native` lane report |
| Smithers, `packages/ci` targets only, by the replay lane's script | 1.32x over 5 commits; every one of them changed `packages/ci` | `~/ci/sci-replay-scratch/run5c/report.json` |

What the numbers say so far: no repository shows a gain yet. Three causes are known.

1. **A fresh install does not stay unchanged, so nothing is reused on a fresh machine** (census lane, 2026-11-18
   00:13, verified). The first `dprint` run hard-links its platform binary into `node_modules`, 46 s into the run. The
   root `node_modules` digest changes, 570 of 734 planned keys change with it, and targets that finish later print
   `not cached: an installed tree changed after it was planned`. Every CI run starts from a fresh install. The census
   of all 734 targets is still running.
2. A target whose confined run reads a file its declaration does not name stores nothing. `//packages/ci:test` is
   one: `PACKAGE.ts` declares no dependencies and `package.json` has seven.
3. On outside repositories a step is one target. needlefish's 3,180 tests are one step; eliza's CI needs `if:`
   conditions, `${{ }}` expressions and runner variables evaluated before one job can run. The replay now runs split
   steps (`d25e74ec261f`), so a split shows up in the next replay.

### Needs Will

- The generated workflow runs `@smthrs/cli@next`, which is rc.16 and refuses the generated workspace. An outside
  repository needs a published build newer than rc.16.
- nyc-01 has no `AI_GATEWAY_API_KEY`, so the fast-mode eval ran on the signed-in subscription model, not Jev.
- Publishing `smithers-ci` and a `@smthrs/cli` newer than rc.16 to npm, through the release workflow. The lane
  `sci-publish` dry-runs the workflow and writes the steps; a person runs them.

The lead (Will's chat session) owns the contracts and the join: one end-to-end
run of `smithers-ci` on a fixture repository, then on the four repositories
above. The dashboard file is `~/.vibe-orch/workstreams/smithers-ci.json`.

## The ship goal and the review loop (Will, 2026-11-18)

Will set the finish line for the product on 2026-11-18 at about 03:28 PST: the engineering is done when an
independent Opus agent reviews Smithers CI and says it is ready to ship and production ready. The loop:

1. An independent Opus reviewer holds the product to what a person reads (the splash page and the docs) by
   running the real program on real repositories. Each blocker carries a clearing condition: one command and
   the result that withdraws it. The conditions are a script, `recheck.sh`, in the reviewer's scratch folder.
2. One lane per blocker clears it on `main`.
3. A new Opus reviewer re-runs the clearing conditions and keeps reviewing. Repeat until the verdict is
   `READY TO SHIP`.

The docs are the specification (documentation-driven development): they are written as the shipped product, and a
gap between a page and the build is work for the build.

### What Will decided about the splash page and the launch (2026-11-18)

- Subtitle: "Fast CI for agents". Tagline: "Give your agent a faster CI feedback loop with incremental, cached
  runs." No draft labels, no jargon, the fewest words that say what the product does.
- The pain: running agents in parallel multiplies how much CI a team runs, and CI becomes the bottleneck.
- What sets it apart: durable, self-hostable, type-safe, Effect as code, with Bazel-like guarantees. The feature
  set is larger than Turborepo's; the page does not say "better than Turborepo".
- The cache: self-hosted first. We also host the default cache and charge for it.
- Rollout: Will asked on Twitter who wants faster CI and makes each person's CI faster himself, one at a time,
  starting with elizaOS/eliza. The case studies that come back are the launch material.

### First ship review (2026-11-18, 03:38 to 06:27 PST): NOT READY

| Blocker | State on 2026-11-18 07:20 PST |
| --- | --- |
| `bunx smithers-ci` cannot run (not on npm) | Runs from its tarball under `npx` and `bunx` (`8f351c51f257`); publishing is a person's step |
| A replay runs `sudo` and changes the machine (fzf) | Lane `sci-no-sudo` |
| The generated `PACKAGE.ts` breaks a repository's own type check (commander.js) | Lane `sci-generated-files` |
| elizaOS/eliza exits 3 with nothing measured | Lane `sci-eliza` |
| The workflow `apply` writes fails on its first run (`@smthrs/cli@next` is rc.16) | Needs a published CLI |
| No outside repository shows a gain (click: 0.51 times, 0 hits in 6 commits) | Lanes `sci-observed-inputs`, `sci-overhead`, `sci-outside-gain` |
| A split step cannot find `npm` | Fix on `main` (`72dccbe3258a`), waits for the re-check |
| A replayed step can push, and sees the real home directory | Lane `sci-step-jail` |
| A run where every step fails locally exits 0 with no reason | Lane `sci-fail-reason` |
| `--mode both` with no model does the work, then drops it | Lane `sci-fast-preflight` |
| Makefiles are not read | Cleared by the reviewer (`2829214d341b`) |
| Ordinary public repositories end with nothing measured | Cleared by the reviewer (`a33f08777d34`, `7cf69db974a2`) |

### What the review loop showed about our own process

- **A report printed "130 times faster" over a failed run.** A five-commit replay of refcell/needlefish on build
  `997d76999db6`: the baseline passed at every commit in about 50 minutes; normal mode failed at every commit in
  about 20 seconds. Rule since (contract round 11): a commit counts toward the speedup only when the baseline
  passed and the mode's results equal it, and the report says how many commits the number covers.
- **Needlefish's ceiling on its newest five commits is 1.67 times.** Three of the five must run every test: the
  first is cold, and two change a module that all 3,180 unit tests compile into one binary.
- **Our own CI was the bottleneck, as the product says it will be.** Fourteen lanes shared two check slots on
  nyc-01; one run waited 114 minutes. A second check host (nyc-02, three more slots, reached through the same
  `checks.sh`) brought a run back to about six minutes. `//packages/ci:test` is one target for the whole package,
  so every lane reruns every test: splitting it per file with the product's own splitter is the real fix.
- **Reuse for a step with no declared inputs is Linux only.** It records reads with `strace`. macOS has no
  unprivileged way to observe a process's reads, so there such a step runs on every change.

### A gain on an outside repository (2026-11-19, lane `sci-outside-gain`)

Ship blocker 6 was: no outside repository shows CI getting faster with every result the same
(`pallets/click`: 0.51 times, 0 steps reused in 6 commits). On `main` at `ca7eea29b4b9`:

| Repository | Head | Commits | Speedup | Mismatches | Steps reused, per commit | Baseline / normal, per commit |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `tj/commander.js`, load 18 to 38 | `3431f07` | 4 | 4.55 | 0 | 18 of 25 at each | 70/14, 66/16, 73/16, 74/16 s |
| the same, as the third reviewer's condition runs it, load 34 to 144 | `3431f07` | 4 | 6.36 | 0 | 18 of 25 at each | 126/20, 111/20, 114/17, 99/14 s |
| `cheeriojs/cheerio`, load 22 to 108 | `13b09c0` | 4 | 1.27 | 0 | 4, 2, 2, 2 of 15 | 219/141, 203/196, 189/145, 166/132 s |

    cd <a clone of tj/commander.js at 3431f07>
    bash ~/ci/quiet-run smithers-ci --commits 4 --json

Measured on nyc-01 under `quiet-run`. commander's four commits change `CHANGELOG.md` or a workflow that is not
replayed, so no step read what changed. The 7 steps that still run: six that restore or save `setup-node`'s
cache (a cache step always runs) and the target that holds the repository's files. Processor time of the
steps: 502 s in the baseline, 76 s in normal mode. The run before the first counted commit took 107 s as the
baseline and 239 s in normal mode, and is in no number. The speedup moves with the load, because the baseline
runs every step and normal mode runs seven short ones; the count of reused steps does not move. A control run
of `eccdddf318b7` at the same time as the reviewer's condition gave 2.09 with 16 of 25.

cheerio's last three commits bump a dependency of its website (`website/package-lock.json`), so the website's
install and what reads it run, rightly. At the fourth, three steps ran for `.git/HEAD changed` (`npm ci` runs
husky, which asks git for the commit), one is never stored (`it opened a network connection (node to 8.8.8.8
port 53)`), and one ran for `~/.config/astro/config.json changed`, Astro's own settings file.

It was 2.55 with 16 of 25 at `eccdddf318b7`, 0.94 with 3 of 36 steps reused at `5e321eee8131`, and 0.57 with
0 of 25 one day earlier. Each row is a
reason a step ran again, read from the run's own record (`notReused` or `notStored` on the step's row):

| The record said | What it was | Fix |
| --- | --- | --- |
| a step after an install always ran | only a job's last step could be reused | every step is recorded and reused, and what it left is kept and put back (`d6df54fbb571`, `f3d4453d4ce2`, generator `7c9a9c051eeb`) |
| `it opened a network connection` on `npm ci` | a warm `npm ci` still calls the registry | an install of exactly what a lockfile pins is stored (`d6df54fbb571`) |
| `~/.cache/uv/archive-v0/<id>/... changed while it ran` | uv fills a directory and renames it into its cache | a file in a directory the run moved into place is the run's own (`30a2212d3256`) |
| `node_modules/@smthrs now exists` | the replay linked a package into each checkout; `npm install` with no lockfile failed on it | the replay puts nothing into `node_modules` (`5e321eee8131`) |
| `its trace holds a line that cannot be read: ???( <detached ...>` | a Go program ends while its threads ask about files | lines for calls a killed thread never made are left out (`9cf758c26817`) |
| `/tmp/smithers-ci-runner-<uid>/<job>/temp changed while it ran` | a job's first step removes its old state directory and makes it again | a directory the run itself made again is the run's own change (`616db69f2b57`) |
| `$TMPDIR/node-compile-cache/... changed`, `~/.config/go/telemetry/...count changed` | Node's compiled code and Go's run counters, a tool's own bookkeeping | left out of what a step read (`7c9a9c051eeb`) |
| `~/.npm/_cacache/index-v5/... changed` | `npm ci` rewrites entries of its own cache index | what a locked install writes outside the workspace is no input (`9ed28e097db9`), also where the home lies in a temporary directory, as a replay's does (`d673d8362485`) |
| `.zig-cache/h/<digest> is gone` | `zig build` opens a manifest with `O_RDWR\|O_CREAT` in a cache directory it just made, and the record took it for a file the run read | a file opened to read or make, in a directory the run made, is the run's own (`ca7eea29b4b9`) |
| exit 4, `//:_repository does not support the lint verb` | the run with the files `apply` writes asked for a group of files as if it were a step; every repository with more than 32 steps ended with no report | it asks for steps only (`eccdddf318b7`) |

Three results would have been wrong. Each was found by a test before a number was reported:

- **A lost read.** strace 6.8 with its seccomp filter, when a thread other than the first starts a program,
  takes the first call of the new program for the answer of `execve` and writes no line for it (36 of 80 runs).
  Such a run is not stored (`9cf758c26817`).
- **A stale pass.** A step that reads a file an earlier step wrote was compared with the bytes at that path
  now. When the earlier step is answered from its record it writes nothing, and a fresh checkout can hold the
  bytes an older run of it left. `main` answered `hit` where a real run fails (`a8561b5c68b0`).
- **A cache step answered from its record.** A step that restores a cache finds its store in the build's own
  cache directory, which no record holds. It always runs (`7c9a9c051eeb`).

The third ship review found two more in this piece, both fixed in Smithers build before the numbers above:

- **The CI `apply` writes did not reuse what the replay counted.** On a runner every step said `runs again: a
  step after it runs, and may read what this one leaves`. The stored record named the cause: `kept.outside`
  held what the step left in its machine's temporary directory
  (`/smthrs-machine/tmp/smithers-ci-runner-<uid>/<job>/steps/-3/outcome`), and kept files are put back only
  while every such path is as the run left it. A file was kept only in the workspace or under `/tmp`. A replay
  keeps its machines under `/tmp`; a runner keeps them under `~/.cache/smthrs/machines`, where a fresh machine
  never has the file. What a step left in its machine's home and temporary directory is now kept and put back
  wherever machines are kept, and a declined archive says why (`1a7aee7ae0aa`). The generated workflow's
  command, run as a runner runs it: ran ran ran, then hit hit ran at a commit only the test reads.
- **A reused build was put back older than its sources.** `make out`, then `make -q out`: the second step
  failed in normal mode and passes in CI, because `out` came back with the time of the run it was kept from.
  Files are now put back as if the step had just run: the newest at the time of the putting back, every one
  newer than what was there before, in the order the step wrote them (`6cb8b0f38f9d`). One offset for the
  whole step holds only when the step's files span less time than putting them back takes; a longer step keeps
  the order and not the gaps, or its first file would be older than the checkout again. With this and the
  manifest fix, a reused `zig build` is a hit on a fresh clone and the zig step after it reports
  `compile exe ... cached`.

Other repositories were measured before a job became a machine (`0607101fad66`), so their numbers are not
`main`'s. What each record showed:

| Repository | Speedup then | Record | Why |
| --- | ---: | --- | --- |
| `highlightjs/highlight.js` | 1.60, 4 mismatches | `build/lib is gone` | its matrix variants each build into `build/` and shared one checkout: a wrong result, which a checkout per job is for. On `main` its replay did not finish four commits in 45 minutes: each of 10 variants runs `npm install`, 59 to 82 s, never stored (`it opened a network connection (node to 8.8.8.8 port 53)`): only an install of exactly what a lockfile pins is |
| `t3-oss/t3-env` | 0.33 | `it opened a network connection (bun to 8.8.8.8 port 53)`, `(turbo to 64.239.123.65 port 443)` | `bun install` without `--frozen-lockfile`; turbo calls its vendor at every run |
| `BurntSushi/toml`, `google/uuid` | 0.49, 0.20 | `README.md changed`, `CONTRIBUTING.md changed` | `go` asks about every file of a package directory, so a docs commit there reruns the tests; a suite of 3 to 15 s is shorter than the start of `smthrs` |
| `pallets/click`, `yargs/yargs` | 0.19, none | `.git/HEAD changed` | `pre-commit run --all-files` and yargs' tests read the commit. A traced `tox` step takes 22 to 28 s against 9 s |

A first run records every step, the installs too. Around its steps it adds 2.0 to 2.2 starts of `smthrs` on a
loaded host, at the limit `FirstRun.benchmark.test.ts` holds (2).

## Fast mode (Will, 2026-11-17)

A second mode beside the normal one.

- **Normal mode** is the Bazel way: it runs every target a change affects and
  never reuses a result it cannot prove.
- **Fast mode** skips everything normal mode skips, and also plans what it
  judges safe to skip even when the dependency graph says the target is
  affected. Will: Facebook "use agents to guess what needs to run. We will
  build a similar workflow."

Will's plan for it, 2026-11-17: a Jev classifier makes the skip decision, and
we eval it. Later, not in the MVP, the recorded data becomes the eval and
training set for our own model, as Facebook trained theirs.

So the MVP records one row per commit and target from its first run: the
change, the target, and whether it failed. Failures are the rare label; most
targets pass on most `main` commits, so the record must include failed runs
from before a merge, not only `main` history.

### The eval matches Facebook's (Will, 2026-11-17)

Will: "our evals should match how facebook trained their model." Source:
Machalica, Samylkin, Porth and Chandra, "Predictive Test Selection", 2018,
[arXiv:1810.05286](https://arxiv.org/abs/1810.05286), sections III to VI.

| Part | Facebook | Ours |
| --- | --- | --- |
| One row | A change and one test target that depends on it | The same; the targets are the ones normal mode selects |
| Label | Positive only when the target failed on that change | The same |
| Flaky failures | A failed target reruns up to ten times or until it passes. Failed means every attempt failed; any pass makes it flaky, and flaky is not a positive | The same |
| Where labels come from | "Learning test runs": every dependent target runs on a sample of changes, close to a quarter of them, off-peak, unseen by developers | The replay in normal mode |
| Split | By time. The most recent week is the test set; the three months before it are the training set | The same split. The Jev classifier is not trained, so the earlier period only supplies its history features |
| Output | A score from 0 to 1 per change and target, from gradient boosted decision trees | A score from 0 to 1 from the Jev classifier, not a yes or no |
| Selection | Every target at or above a score cutoff, plus the top N by score | The same two settings |
| Refresh | Weekly: retrain, check the bar, replace the model or alert a person | Weekly: re-score; below the bar, fast mode switches off |
| Missed failure | Caught later in the stabilization stage, which runs everything | Caught by normal mode before a release |

The three metrics, as the paper defines them:

- **Test recall:** of all failures, the share whose target was selected.
- **Change recall:** of all changes with a failure, the share where at least
  one failing target was selected.
- **Selection rate:** targets selected, divided by targets the dependency
  graph selects.

Facebook's production bar: test recall above 0.95 and change recall above
0.999. Its weekly check: selection rate below 0.3 at test recall 0.9.

Features in the paper's best model, which each row records and the classifier
reads: extensions of the changed files; how often those files changed in the
last 3, 14 and 56 days; the target's failure rate over the last 7, 14, 28 and
56 days; the project name; the number of tests in the target; and the shortest
dependency-graph distance from a changed file to the target. The paper dropped
four others because they made the model worse: files changed, targets
triggered, shared path tokens and distinct authors.

A limit to state on the splash and in the docs: a change recall of 0.999
cannot be measured on fewer than a thousand changes that failed. On a small
history we report the recall we measured and the count behind it.

Not designed yet. Three constraints the design must meet, the agent's reading
and not Will's words:

1. `AGENTS.md` says "never weaken affected selection to compensate for missing
   cache contracts." Fast mode is a separate, named mode; it does not change
   what normal mode selects.
2. A target fast mode skips is recorded as skipped by prediction. It is never
   stored or reported as passed, and never becomes a cache hit.
3. The replay measures it: run N commits in both modes and count the failures
   fast mode missed. Fast mode ships with that number.

## Parked, so we don't forget

Found while scoping this on 2026-11-17. None is owned by this note.

- **Red runs, not slow runs, stalled VibeLang's queue on Nov 14.** A fuzz test
  picked programs by position; eight batches failed in six hours.
- **rc.18 had no owner for 44 hours.** Ten of its gates fail on real defects.
- **Nothing decides what enters the queue.** 191 of VibeLang's 276 waiting
  changes were review fixes; that thread wrote 254 fixes and landed 7.
- **No Smithers build is published since rc.16 (Oct 20).** `bunx smithers-ci`
  needs one.
- **Bun installs are refused;** only pnpm installs run.
- **No repository outside ours has run Smithers build.**
- **`Areas/Competition.md` in the ops vault names no CI competitor:** no Nx
  Cloud, Turborepo, Depot or Blacksmith.
- **Later parts of `smithers-ci` from Will's notes:** Jev lint suggestions, Nix
  sandboxes, the hosted object store and its price, keeping old commits'
  CI working.
- **The main checkout's jj working copy sits on a week-old operation**
  (`98876aaa63fe`); `jj st` there fails until `jj op integrate` runs.

## Open questions for Will

None.
