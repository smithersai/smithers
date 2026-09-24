---
title: "LlmLint"
description: "Reviews changed files with a model against a rubric, and fails on findings."
---

Reviews changed files with a model against a rubric and fails on findings.

```ts
import { Smithers } from "@smthrs/targets"

const review = Smithers.LlmLint({
  changes: Smithers.gitDiff("origin/main"),
  include: [Smithers.glob("//packages/**/*.ts")],
  context: [Smithers.glob("//docs/reference/*.md")],
  deps: [],
  prompt: "You are reviewing a TypeScript monorepo.",
  rubric: "Public exports must carry JSDoc with @since and @category.",
  engine: "claude",
  model: "claude-opus-5",
  batchSize: 8,
  failOn: "error"
})

export const Package = Smithers.Package({
  targets: { review }
})
```

## Attributes

| Name        | Type                             | Default    | Description                                                                                                       |
| ----------- | -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `changes`   | `Input.GitDiff`                  | required   | The base revision whose diff selects the reviewed files.                                                          |
| `include`   | `Array<Input.Glob>`              | required   | Declared globs matched against workspace-relative changed paths. A path is reviewed when it matches at least one. |
| `context`   | `Array<Input.Glob>`              | `[]`       | Declared globs read on every round and appended to every batch prompt whether or not they changed.                |
| `deps`      | `Array<Target.Target>`           | required   | Dependency targets.                                                                                               |
| `prompt`    | `string`                         | required   | The instruction text prepended to every batch.                                                                    |
| `rubric`    | `string`                         | required   | What the model checks against.                                                                                    |
| `engine`    | `"claude" \| "codex"`            | `"claude"` | The model CLI the review spawns.                                                                                  |
| `model`     | `string`                         | required   | Passed to the CLI as `--model`. Also becomes the target's `layers` key material as `model:<value>`.               |
| `batchSize` | integer 1-128                    | required   | Maximum changed files per model call.                                                                             |
| `failOn`    | `"info" \| "warning" \| "error"` | `"error"`  | The severity that fails the target.                                                                               |

## What execution would do

The plan is one call to the `smithers-build/llm-review` action.
`LlmReviewLive({ workspaceRoot, executable })` implements it:

1. `git diff --name-only -z <base> --` lists changed paths in the workspace root.
2. Paths matching at least one `include` glob are kept and sorted.
3. They are batched by `batchSize`. Paths deleted since the base revision are
   skipped when the batch is read.
4. Every `context` path or glob is expanded against the workspace and read
   once, whether or not it appears in the diff.
5. Each batch becomes one engine call. `engine: "claude"` runs
   `claude -p <prompt> --output-format json --model <model>`; `engine: "codex"`
   runs
   `codex exec --json --skip-git-repo-check --sandbox read-only --model <model> <prompt>`.
   The prompt separates a `CHANGED FILES` section from a `CONTEXT FILES`
   section.
6. The response is parsed as a JSON array of
   `{file, line, severity, message}`. For `claude`, a bare array, a
   `{result: [...]}` envelope, and a `{result: "...[...]..."}` string envelope
   are all accepted. For `codex`, the last `agent_message` item of the JSONL
   event stream carries the array.
7. Findings whose severity meets `failOn` fail the target.

`executable` overrides the engine's default binary name.

## Inputs

The `changes` declaration is collected from the attrs. The planner expands it as
a [git diff input](../../concepts/inputs.md#git-diffs): the file list comes from
`git diff --name-only`, and the digest is the sha256 of the
`git diff --binary <base>...HEAD` patch text.

Every `include` and `context` entry is declared as a workspace-rooted glob
input. The include inputs make working-tree source edits key material even
though the git diff digest covers committed history; context inputs make an
unchanged reference file re-key the target when its content changes.

The target therefore re-keys when the diff, reviewed source, or context content
changes.

## Key material

Beyond the usual fields, this target contributes:

| Field          | Value                        |
| -------------- | ---------------------------- |
| `layers`       | `["model:<model>"]`          |
| `capabilities` | `["git:diff", "model:call"]` |

## Channels

| Channel | Type                                                                                 |
| ------- | ------------------------------------------------------------------------------------ |
| Success | `Report`: `{files: Array<string>, findings: Array<Finding>}`                        |
| Error   | `ReviewError`: a union of `ModelCliMissing`, `LlmReviewError`, and `FindingsError` |

```ts
Finding = { file: string, line: number, severity: Severity, message: string }
```

`line` is 1-based; whole-file findings report line 1.

| Error              | Raised when                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `ModelCliMissing` | The engine executable was not found on the host. Carries `engine` and `executable`. |
| `LlmReviewError`   | A round failed at `diff`, `read`, `review`, or `parse`                                                                   |
| `FindingsError`    | The review completed and at least one finding met `failOn`. Carries the complete finding set, not only the failing ones. |

## Status

|           |                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| Kinds     | `review`, and gated to it                                                                                          |
| Cacheable | Never; remote model output is not reproducible                                                                     |
| Executes  | **Yes.** The CLI executor provides `LlmReviewLive({ workspaceRoot })`, so `smithers-build review` runs the review. |

`review` is its own verb, and the aggregate `ci` does not plan it. Two facts
force that. The target expands `changes` at PLAN time, so a checkout without
the base revision, which is every `actions/checkout` without `fetch-depth: 0` on
a pull request, kills the whole plan rather than only this node. And it spawns a model CLI,
which a hosted runner has neither the binary nor a credential for. So
`smithers-build lint '//...'`, `test`, `build`, `docs`, and `ci` never select a
review target, and `verbGate` refuses one reached through a dependency edge as
well. Run them by name:

```sh
smithers-build review '//...'
smithers-build review '//packages/core:reviewChangedFiles'
smithers-build //packages/core:reviewChangedFiles   # the bare-label form
```

An exact label under another verb is the ordinary `UnsupportedVerbError`.

A host with no engine binary SKIPS rather than fails: the executor reports
`ModelCliMissing` as a skipped target carrying a notice that names the
executable, and a skipped target leaves the run green. A machine without the
model CLI cannot say whether the diff is clean, and reporting "unclean" for
that is a red gate no commit can turn green.

Planning, `query`, and `graph` work normally.

## See also

- [Inputs](../../concepts/inputs.md)
- [Actions and boundaries](../../concepts/actions-and-boundaries.md)
- [Running targets](../../workspace/running-targets.md#what-executes)
