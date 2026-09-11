---
title: "The migration report"
description: "The report is the tool's real output: a deterministic record of what was translated, what was refused, what a person still owes, and how to undo any of it."
sidebar:
  order: 4
---

`plan` and `apply` write `.smithers-migrate/report.json` and
`.smithers-migrate/report.md`. `--report-dir` moves both. The JSON is the
record; the Markdown is a pure function of it, and every list inside both is
sorted, so two runs of the same project differ only in the `generatedAt`
timestamp. A reviewer sees what actually changed.

Review, then commit `report.md`. It is the record of what the tool changed,
what it could not translate, and what a person still has to decide.

## The sections, in order

| Section                             | What it holds                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Summary                             | Project root, mode, exit code, run-state verdict, and the counts.                         |
| Run state and operator instructions | The 0.x run state that was found, and the instructions in the order you must act on them. |
| Project detection                   | Manifests, lockfiles, tsconfigs, workflow files, prompts, components, tests, and config.  |
| Construct inventory                 | Every construct hit, with its file, line, and class.                                      |
| Mapping decisions                   | One row per distinct construct: its target, its rule, and its class.                      |
| Units                               | One entry per unit: sources, targets, status, changed files, and decisions.               |
| Verification                        | Every command that ran, its exit status, and its captured output.                         |
| Manual follow-ups                   | The checklist a person owes.                                                              |
| Appendix: restoring a checkpoint    | The command that restores each unit's checkpoint.                                         |

## Unit statuses

| Status     | What it means                                                                  |
| ---------- | ------------------------------------------------------------------------------ |
| `planned`  | `scan` and `plan` never migrate anything, so this is what they report.         |
| `blocked`  | The unit holds a construct with no safe translation and was not attempted.     |
| `migrated` | The unit rewrote, verified, archived, and satisfied its postconditions.        |
| `failed`   | The unit failed and was restored from its checkpoint. The next unit still ran. |

## How the exit code is computed

The report computes its own exit code, and the CLI reports it:

| Exit | When                                                         |
| ---- | ------------------------------------------------------------ |
| `0`  | No unit failed, and nothing is blocked in `apply` mode.      |
| `1`  | At least one unit failed and was restored.                   |
| `3`  | `apply` parked: unacknowledged run state, or a blocked unit. |

A failed unit outranks a blocked one, so a run with both exits 1. `scan` and
`plan` never exit 3: they report the blockage rather than park on it, which is
the whole point of running them first.

## Follow-ups have a severity

The follow-up checklist is built from everything a person still owes:

- `must`: a run-state instruction, a construct with no counterpart, a failed
  unit, or a blocked unit.
- `should`: an unresolved entry, such as an agent pool whose seats are yours to
  choose.

## Two unions worth reading first

`unsupported` is every construct the migration refused to translate, with the
file and line where it appears and the closest thing 1.0 offers. Each one is
also a `TODO(migrate-smithers-v1)` marker left in the rewritten source.

`unresolved` is every decision the tool declined to make for you. The largest
group is agent pools: `ClaudeCodeAgent`, `CodexAgent`, `OpenCodeAgent`, and
`fallbackAgents` hits each become an entry offering subscription auth through
the flows harness or an API seat, and each says that a pool stays a pool.
Workflow import cycles land here too, naming the order the tool had to choose
for itself.

## Verification output is redacted, then captured

Every verification command's last 12 KB of stdout and stderr is captured into
`report.json`, and the report says how many earlier bytes were dropped.

Before the report is written, that output passes through the journal's shared
redaction rules, the same rules `smthrs bug` applies: bearer and basic
authorization values, `*_KEY=`, `*_TOKEN=`, `*_SECRET=` and `*_PASSWORD=`
assignments, URL credentials, private key blocks, JWTs, and known provider key
shapes become `[REDACTED]`. The rules match known shapes only. The
Verification section says so beside the commands whenever any output was
captured. Read that section before you commit the report.

## Reading it from a script

`--json` prints the whole report document to stdout instead of the human
summary, and the same document is what `report.json` holds. `Report.toMarkdown`
renders any decoded report back to the same Markdown bytes, so a tool that
reads the JSON can render its own view without reimplementing the renderer. See
[Read a project from your own script](../guides/embed-the-scanners.md).
