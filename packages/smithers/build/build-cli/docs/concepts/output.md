---
title: "Output and renderers"
description: "Shared human/agent detection, quiet machine results, and live task progress without mixing output channels."
sidebar:
  order: 3
---

The shared `Audience` policy separates **who is reading** from **how results are
encoded**. Verified harness markers select agent mode even inside a PTY; humans
receive progress eagerly, while agents receive concise Incur results and useful
next commands with progress silent by default. CI and non-interactive pipes use
conservative machine output. Detection never changes permissions or approvals.

Override with `--audience human|agent|auto` or `SMITHERS_AUDIENCE`. `--silent`
suppresses progress, not results, errors, or explicitly requested logs;
`--quiet` remains available where previously supported, with legacy alias output
unchanged; prefer `--silent` across groups. `--verbose` opts agents into plain
progress. MCP always stays machine-clean. See the
[verified harness registry](../reference/agent-detection.md).

The CLI writes to two streams and never mixes them.

**Standard output belongs to the structured envelope.** incur prints the
command's return value there, TOON by default, or JSON, YAML, Markdown, or
JSONL under `--format`. A program reading `smithers-build query --format json`
sees exactly the envelope and nothing else.

**Standard error belongs to progress.** A reporter turns execution events into
whatever the selected renderer draws. Humans see task lifecycle and log feedback
as work happens; Clack supplies live feedback and prompts. Because progress never
touches standard output, `--format json` is never contaminated by a spinner.

## The three renderers

| Renderer | What it draws                                                                             |
| -------- | ----------------------------------------------------------------------------------------- |
| `plain`  | One line per settled target and one summary line. Bare text, no colour, no cursor motion. |
| `stream` | The same events with colour, glyphs, and aligned columns, and still no cursor motion.     |
| `tty`    | Draws in place: running targets spin at the bottom, settled targets scroll above them.    |

`plain` is appropriate for stable captured logs. `stream` is safe wherever
colour is; `tty` provides the live running-task view familiar from Bazel and Nx.

## How auto resolves

`--ui` takes `auto`, `tty`, `stream`, or `plain`, and defaults to `auto`. It
selects the target renderer within the audience policy; it cannot override agent
silence or `--silent`. `SMTHRS_UI` supplies an environment preference.

Terminal capabilities control animation; CI and `TERM=dumb` avoid cursor motion,
and `NO_COLOR` disables color. Redirected progress degrades to stable lines.
These hints do not identify an agent. An explicit JSON format controls standard
output independently, so a human can still follow progress on standard error.

## What a person sees instead of the envelope

When the audience policy selects unstructured human output, the CLI renders the result as text on
standard output and returns no envelope data. `query`, `graph`, and `owners`
each have a text form for exactly this: aligned columns for a listing, a tree
for a graph, a table for owners.

Two consequences follow.

- A green execution summary a renderer already drew leaves standard output
  empty. The information was not lost; it was drawn on standard error as it
  happened.
- A red execution summary a renderer already explained records only the exit
  code, so the envelope's error block is not printed a second time.

`graph --mermaid` is the exception in the other direction. Mermaid is meant
for a file or a renderer, never a terminal, so that form is always returned as
data.

## Reading output from a program

Ask for the format you want and read standard output:

```bash
smithers-build query 'deps(//packages/api:lib)' --format json
smithers-build ci '//packages/...' --plan --format json
smithers-build targets '//packages/...' --format json
```

[Commands](../cli.md) lists every command and the formats it accepts. The main
`smithers` CLI shares this policy but registers its own commands, including the
paged run-history reader; see
[its command reference](../../../../docs/reference/cli/README.md).

Use `--silent` to suppress unsolicited progress, or `--ui plain` for stable
target-progress lines. The two streams can always be captured separately.

## Embedding and maintenance

`Audience.resolve` takes injected environment and stream facts and returns one
policy for results, progress, and prompting. `Audience.fromArguments` handles
executable presentation flags; `Audience.incurArguments` selects structured
formatting for harness-owned PTYs without changing process streams. Renderers
consume this policy instead of maintaining separate detection logic. Add only
source-verified markers, with false-positive tests alongside them.
