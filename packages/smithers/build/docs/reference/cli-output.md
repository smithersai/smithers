---
title: "Terminal output"
description: "What smithers-build prints while it runs: the --ui renderers, how auto picks one, and which stream each kind of output goes to."
---

What `smithers-build` prints while it runs, how it decides between a live display, a
coloured log, and bare lines, and where each stream goes.

Every command still returns structured data on standard output through
[incur](https://github.com/wevm/incur). This page is about the human side:
progress on standard error, and the tree or table a person sees instead of
the envelope.

## Renderers

| Renderer | What it does                                                                                                                                                                  | When `auto` picks it                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tty`    | Draws in place. Running targets spin at the bottom of the screen with their elapsed time; settled targets scroll above them in completion order; a footer closes the run.     | Standard output and standard error are both terminals.                                               |
| `stream` | The same glyphs, colours, and aligned columns, one line per event, never moving the cursor. Safe in any log that accepts colour.                                              | Standard error is a terminal but standard output is not, or `FORCE_COLOR` is set under a pipe or CI. |
| `plain`  | Exactly the lines the executor has always printed: `label  status  duration` per settled target and `N targets: a hit, b ran, c failed, d skipped (t)` at the end. No colour. | Anything else: a pipe, `CI`, `NO_COLOR`, `TERM=dumb`, or an explicit `--format`.                     |

`--ui <auto|tty|stream|plain>` is a global option on every command and wins
over everything. `SMTHRS_UI` in the environment is the default for `--ui`,
in the manner of Turborepo's `TURBO_UI` and Nx's `NX_TUI`.

The full order `auto` applies:

1. `SMTHRS_UI`, when it names a renderer.
2. `--format` or `--json` given: `plain`. A program is reading.
3. `NO_COLOR` non-empty, or `TERM=dumb`: `plain`.
4. `CI` non-empty: `stream` when `FORCE_COLOR` asks for colour, else `plain`.
5. Two terminals: `tty`.
6. A terminal on standard error, or `FORCE_COLOR` under a pipe: `stream`.
7. Otherwise `plain`.

Colour follows [no-color.org](https://no-color.org) and
[force-color.org](https://force-color.org): `NO_COLOR` set to anything but
the empty string wins, then `FORCE_COLOR` (`0` and `false` refuse, any other
value forces), then `TERM=dumb` refuses, then the stream must be a terminal.
An explicit `--ui tty` under `NO_COLOR` draws live without colour.

## Streams and exit codes

Progress always goes to standard error. With `--format json` on a terminal,
`auto` picks `plain`, so the envelope on standard output is never interleaved
with a spinner; with `--ui tty --format json` the live display still runs on
standard error and the JSON still arrives clean on standard output.

When a human renderer is active and incur agrees standard output belongs to a
person, an execution command prints nothing on standard output: the display
already said everything the envelope would. A red run ends with one red line,
`✗ 2 of 6 targets failed: //src:a, //src:b`, and exit code 1; incur's
`Error (targets_failed): …` block is not printed, because the same fact is
already on the screen. Under a pipe, `--ui plain`, or an explicit format the
envelope and the structured `code`, `message`, `retryable` error are exactly
what they were.

`query` renders a listing as `LABEL`, `TARGET`, `KINDS` columns and
`deps(label)` as the root over its closure; `graph` renders the tree with dim
box-drawing, a bold root, cyan rule names, and dim file groups. Both write to
standard output, because they are the command's answer rather than progress,
and both return the structured data instead whenever a program is reading.
`graph --mermaid` is always the envelope.

## Anatomy of a run

```text
▸ //:all  5 targets · 16 jobs
✗ //:lintCheck    failed      20ms
    command failed (exit 1): /bin/sh -c echo 'src/App.tsx:12:5 error: unused variable foo' >&2; exit 1
    src/App.tsx:12:5 error: unused variable foo
    src/Nav.tsx:4:1 warning: missing return type
✗ //:smoke        failed       0ms
    refused: gate //:lintCheck is not green (gates: //:lintCheck=failed)
✓ //:unit                     1.1s
✓ //:integration              2.0s
✗ //:all          failed       0ms
    suite is red; members: //:unit=ran, //:integration=ran, //:lintCheck=failed, //:smoke=failed

Tasks: 2 ran, 3 failed, 5 total · Time: 2.1s
✗ 3 of 5 targets failed: //:all, //:smoke, //:lintCheck
```

| Element                              | Meaning                                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `▸ verb pattern  N targets · J jobs` | The header, once per run. The bare-label form shows the label alone.                                                                                                                                                                         |
| `✓` green                            | Ran green.                                                                                                                                                                                                                                   |
| `○` dim, `cached`                    | Answered from the result cache.                                                                                                                                                                                                              |
| `✗` red, `failed`                    | Executed and failed, or refused. The first line under it is the failure message. Lines the producer indented, such as an agent lint's findings, are a `•` list; a tool's own output tail is shown as the tool wrote it.                      |
| `↷` yellow, `skipped`                | Never ran because a dependency did not succeed.                                                                                                                                                                                              |
| Right-aligned duration               | Milliseconds below one second, tenths of a second above, in one column for every line.                                                                                                                                                       |
| Dim `label  message` lines           | The executor's progress notes: cache misses, service readiness, agent rounds, closure sizes.                                                                                                                                                 |
| `⚠` yellow                           | A run-level warning, such as a cache store the executor could not write.                                                                                                                                                                     |
| `Tasks: … · Time: …`                 | The footer. Zero counts are omitted; `total` is always present. When every target was a cache hit the line ends `>>> FULL CACHE`.                                                                                                            |
| `⠋ label  elapsed`                   | `tty` only. One pinned line per running target, at most eleven, then `… N more running`, then `done/total · running · elapsed`. The pinned lines are cut to the terminal width so the redraw arithmetic holds; scrolled lines are never cut. |

Under `stream` a dim `▸ label` line marks each start, so a hung target is
visible in a CI log.

## Contract for executors

The `Reporter` service is the seam. An executor receives one and reports events;
it never formats a line.

| Event                                     | Reported when                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `begin({ verb, pattern, jobs, targets })` | Once, before scheduling, so the renderer can size its label column.                                                                                                            |
| `targetStarted(label)`                    | A target enters the scheduler and is not blocked by a failed dependency.                                                                                                       |
| `targetFinished(report)`                  | A target settles as `hit`, `ran`, `failed`, or `skipped`.                                                                                                                      |
| `note(line)`                              | A free-form progress line: `label  message` or `smthrs: message`.                                                                                                              |
| `warn(line)`                              | A run-level warning.                                                                                                                                                           |
| `toolOutput(label, stream, chunk)`        | A child's output chunk. No executor streams a child today: `ExecLive` captures both pipes and folds their tails into the failure message. The hook is there for when one does. |
| `summary(summary)`                        | Once, with the final counts.                                                                                                                                                   |
| `close()`                                 | Always, in a `finally`, so a live renderer hands the terminal back.                                                                                                            |

`Reporter.of({ reporter, log })` keeps the older `log` sink working: without a
reporter it builds the `plain` renderer over `log`, and without either it
writes plain lines to standard error. That is what keeps `Executor.execute`
and `PackageExec.run` byte-identical for every caller that passes `log`.

## Prior art

| Tool  | Mode selection                                                                                                         | Live display                                                                                                                                                                            | Cache hit                                                           | Footer                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bazel | `--curses=auto`, `--color=auto`, both resolved by the client's `--isatty`; `TERM` `dumb`, `emacs`, `xterm-mono` refuse | A progress bar pinned at the bottom, cleared with cursor-up and erase-line, redrawn at `--show_progress_rate_limit` (0.2 s), floored to 1 s without cursor control; events scroll above | `[N / M] Executing genrule …` counters rather than per-target lines | `INFO: Elapsed time: 3.212s, Critical Path: 1.10s`, `INFO: N processes: …`, `INFO: Build completed successfully, N total actions` or `FAILED: Build did NOT complete successfully` |
| Buck2 | `--console auto\|simple\|simplenotty\|simpletty\|super\|none`, `BUCK_CONSOLE`; superconsole when stderr is a TTY       | superconsole: a canvas at the bottom re-rendered each tick, emitted lines above it never touched again                                                                                  |                                                                     |                                                                                                                                                                                    |
| pnpm  | `--reporter default\|append-only\|ndjson\|silent`; `append-only` when `CI` or stdout is not a TTY                      | `ansi-diff` over the bottom frame, `\x1b[0J` after every update, 200 ms throttle on a TTY and 1 s in append-only mode                                                                   |                                                                     |                                                                                                                                                                                    |

Sources: Bazel [command-line reference](https://bazel.build/reference/command-line-reference),
[user manual](https://bazel.build/docs/user-manual),
[`UiOptions.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/UiOptions.java),
[`UiEventHandler.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/UiEventHandler.java),
[`UiStateTracker.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/UiStateTracker.java),
[`BuildSummaryStatsModule.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/BuildSummaryStatsModule.java),
[`BuildResultPrinter.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/buildtool/BuildResultPrinter.java).
Buck2 [interactive console](https://buck2.build/docs/users/build_observability/interactive_console/),
[common options](https://buck2.build/docs/users/commands/common-options/),
[`superconsole.rs`](https://github.com/facebookincubator/superconsole/blob/main/src/superconsole.rs).
pnpm [install](https://pnpm.io/cli/install), [CLI settings](https://pnpm.io/settings/cli),
[`pnpm/src/main.ts`](https://github.com/pnpm/pnpm/blob/main/pnpm11/pnpm/src/main.ts),
[`default-reporter/src/index.ts`](https://github.com/pnpm/pnpm/blob/main/pnpm11/cli/default-reporter/src/index.ts).
Conventions [no-color.org](https://no-color.org), [force-color.org](https://force-color.org),
[`supports-color/index.js`](https://github.com/chalk/supports-color/blob/main/index.js).

What this design takes from each:

| From  | Taken                                                                                                                                                                                                                                | Left out, and why                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Bazel | Cursor-up plus erase-to-end-of-screen redraw of a bottom region; the region is cut to the terminal width so the line count is exact; `--curses=auto` becoming a TTY check; one final status line rather than a scrolling INFO stream | `--show_progress_rate_limit`, `--progress_in_terminal_title`, `--show_result`: no user has asked for them. |
| Buck2 | The canvas-and-emit model: emitted lines above the canvas are written once and never revisited, only the canvas is redrawn                                                                                                           | `--console` sub-panels.                                                                                    |
| pnpm  | `append-only` as the precise meaning of `stream`, no cursor manipulation ever; `\x1b[0J` after every frame so anything a child printed below the frame is cleared                                                                    | `ndjson`: incur's `--format jsonl` already covers a machine consumer.                                      |

## Before and after

Taken from [artsy/force](https://github.com/artsy/force), a PACKAGE.ts
workspace, on a red `biome lint`. `--ui plain` is what every version printed
before this page existed; the `tty` sample is ANSI-stripped and the spinner
frames are omitted.

`smithers-build //src:lint --ui plain`, piped:

```text
//src:srcs  ran  3ms
//src:lint  failed  1.9s  command failed (exit 1): /usr/bin/sandbox-exec -p (version 1)(allow default)(deny network*)(allow network* (local unix-socket)) <workspace>/node_modules/.bin/biome lint --no-errors-on-unmatched
of consistent names through a code base.

  i Use a named export instead.

<workspace>/__mocks__/@loadable/component.tsx:4:3 lint/style/useConst  FIXABLE  ━━━━━━━━━━
…
2 targets: 0 hit, 1 ran, 1 failed, 0 skipped (1.9s)
code: targets_failed
message: 1 of 2 targets failed
retryable: false
```

`smithers-build //src:lint --ui tty` on a terminal:

```text
▸ //src:lint  2 targets · 16 jobs
✓ //src:srcs               3ms
✗ //src:lint  failed      1.4s
    command failed (exit 1): /usr/bin/sandbox-exec -p (version 1)(allow default)(deny network*)(allow network* (local unix-socket)) <workspace>/node_modules/.bin/biome lint --no-errors-on-unmatched
    of consistent names through a code base.
      • i Use a named export instead.
    <workspace>/__mocks__/@loadable/component.tsx:4:3 lint/style/useConst  FIXABLE  ━━━━━━━━━━
    …

Tasks: 1 ran, 1 failed, 2 total · Time: 1.9s
✗ 1 of 2 targets failed: //src:lint
```

`smithers-build //src/Server:test --ui tty`, second run, answered from the cache.
The private label's declaration-position digest is abbreviated as `<digest>`:

```text
▸ //src/Server:test  3 targets · 16 jobs
✓ //src/Server:srcs                                    1ms
  //src/Server:__private_ImportClosure_<digest>  closure: 3061 files, 91 packages, 0 unresolved, 0 dynamic
✓ //src/Server:__private_ImportClosure_<digest>               0ms
○ //src/Server:test                       cached       0ms

Tasks: 2 ran, 1 cached, 3 total · Time: 4ms
```

`smithers-build query '//...' --ui tty` on a terminal:

```text
LABEL                                           TARGET                  KINDS
//.github:ci                                    Github.Workflow         run lint
//.github:danger                                Shell.Run               run
//.storybook:storybookBuild                     Shell.Build             build
//:detectSecrets                                Shell.Test              test
//data:schema                                   Filegroup
```

`smithers-build graph '//src:build' --ui tty` on a terminal:

```text
//src:build
  -data-> //src:buildClient
  -data-> //src:buildServer
```

The same commands under a pipe, with `--format json`, or with `--ui plain`
print the envelope they always did.

## Not done

Child output does not stream, so `toolOutput` has no producer and there is no
grouped or prefixed log mode; the failure tail is the whole of a tool's
voice. There is no interactive pane, no keybindings, no terminal title, and
no GitHub Actions log folding. Build-system `graph` has never had a Mermaid
renderer; `--mermaid` there still returns the text graph in the envelope.
