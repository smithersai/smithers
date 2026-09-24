---
title: "Docs.Page"
description: "Writes one documentation page with an agent under the docs verb."
---

Writes one documentation page with an agent under the `docs` verb.

```ts
import { Smithers } from "@smthrs/targets"

const brief = Smithers.file("pages/reference/packages/flow/brief.md")
const references = Smithers.Filegroup({ srcs: [Smithers.glob("references/**")] })
const codeBlocks = Smithers.Markdown.CodeBlocks({
  file: Smithers.file("src/content/docs/docs/reference/packages/flow.mdx"),
  lang: ["ts", "sh"]
})

const flowReference = Smithers.Docs.Page({
  agent: Smithers.Agents.default,
  brief,
  prompt: Smithers.file("prompts/reference.md"),
  references: [Smithers.file("prompts/style.md"), references],
  inputs: [Smithers.glob("//packages/greeter/src/**/*.ts")],
  output: "src/content/docs/docs/reference/packages/flow.mdx",
  gates: [codeBlocks],
  maxRounds: 3
})

export const Package = Smithers.Package({
  targets: { flowReference }
})
```

A page is the docs-shaped subset of [`Agent.Diff`](../../concepts/actions-and-boundaries.md):
one brief, one prompt, the references the writer may read, the inputs the page
describes, and exactly one output. The output path is the whole write-set. A
candidate that touches any other path is rejected whole, and the tree is left
untouched.

## Attributes

| Name         | Type                              | Default  | Description                                                                                                                     |
| ------------ | --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `agent`      | `AgentSelector`                   | workspace default | A workspace agent reference (`Smithers.Agents.luna`) or an inline declaration (`Smithers.Agent.Codex("gpt-6-luna")`).    |
| `brief`      | `Input.File`                      | required | The human-written paragraph saying what the page is for, its audience, and its type. A declared file input.                    |
| `prompt`     | `Input.File`                      | required | The page-type instructions the session runs with. A declared file input, at most 1 MiB.                                        |
| `references` | `Attr.Data`                       | required | Files, globs, filegroups, and targets the writer may read for style and taxonomy. Rendered under `=== FILES ===` in the prompt. |
| `inputs`     | `Attr.Data`                       | required | The code the page describes, in the same member shapes as `references`.                                                        |
| `output`     | `string`                          | required | The one page path, package-relative or `//`-rooted. It is the complete write-set.                                               |
| `gates`      | `Array<Target.Target>`            | required | Check/test-capable targets run against each candidate inside the loop. A `Shell.Run` or outward target cannot gate.            |
| `maxRounds`  | integer 1-16                      | required | Rounds the candidate/gate loop runs before it fails with `AgentRoundsExhausted`.                                                |
| `sandbox`    | `Attr.Sandbox`                    | confined | The session's sandbox policy: default confinement, `{ network: "loopback" }`, `{ network: true }`, or `"none"`.                 |
| `approval`   | `"required"`                      | none     | Refuses until a durable approval is granted.                                                                                    |

`Docs.Page` deliberately has no `payload`, `mcp`, `secrets`, or `changes`
attr. A page is a pure function of committed files plus the model, so it takes
no invocation-time inputs, and its write-set is its output.

## What execution does

The plan is one call to the `smithers-build/agent-diff` action, with the
payload the equivalent `Agent.Diff` declaration would plan:

```ts
Smithers.Agent.Diff({
  agent,
  prompt,
  data: [brief, ...references, ...inputs],
  changes: [output],
  gates,
  sandbox,
  approval,
  maxRounds
})
```

The package executor runs it through the same candidate/gate lane as
`Agent.Diff`: the session proposes a candidate, the declared gates run against
a scratch copy carrying exactly that candidate, and the first green round is
applied to the tree. `AgentSession` in `@smthrs/build-cli` is the only agent
loop; this rule adds none.

## Inputs

`brief`, `prompt`, and every file or glob in `references` and `inputs` are
declared inputs, so editing any of them re-keys the page. Filegroups and
targets in `references` and `inputs` are dependencies; their files reach the
prompt through the lane's data labels. The prompt file itself is never listed
under `=== FILES ===`.

## Channels

| Channel | Type                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Success | `DiffResult`: `{vacuous, rounds, diff, edits, gateReport}`                                                               |
| Error   | `DiffError`: `AgentNeedsInput`, `AgentMcpUnreachable`, `AgentWriteEscape`, `AgentRoundsExhausted`, or `AgentSessionError` |

## Status

|           |                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Kinds     | `docs`                                                                                                           |
| Cacheable | Never; an agent is not a pure function of its inputs. The committed page is the cache.                          |
| Executes  | **Yes.** `smithers-build docs '//apps/site/...'` plans and runs every page writer in the pattern.                |

`ci` plans the `docs` verb and still never selects a `Docs.Page` root: CI never
spawns an agent. The executor plans the aggregate with `unattended: true`, and
that flag drops every rule that spawns an agent under a verb `ci` aggregates.
An exact `Docs.Page` label under `run`, `build`, `test`, or `lint` is the
ordinary `UnsupportedVerbError`.

```sh
smithers-build docs '//apps/site/...'           # regenerate the pages in the pattern
smithers-build docs //apps/site:flowReference   # one page by name
smithers-build ci '//apps/site/...'             # parity checks and gates only; no writer runs
```

Whether a committed page is older than its inputs is
[`Docs.Check`](docs-check.md), a separate deterministic rule that runs under
`lint`, `docs`, and therefore `ci`, with no agent. This rule only writes; that
one only judges. Declare both beside each other, and refresh the stamp with
`smithers-build docs //apps/site:fresh --write` after regenerating the page.

## See also

- [Docs.Check](docs-check.md), the freshness gate for the page this rule writes
- [Inputs](../../concepts/inputs.md)
- [Actions and boundaries](../../concepts/actions-and-boundaries.md)
- [Running targets](../../workspace/running-targets.md#what-executes)
