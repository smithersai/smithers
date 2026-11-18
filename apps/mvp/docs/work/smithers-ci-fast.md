---
title: Fast Smithers CI (customer zero for smithers-ci)
status: in-progress
area: build
owner: Claude Fable, Will's chat session 20474551, since 2026-11-17 16:50 PST
updated: 2026-11-17 17:50 PST
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

## Order of work

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
| Eyebrow | "Smart CI that only runs what changed" (Will) |
| Tagline | Open |
| Buttons, install command, stats | Not started |

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
