---
title: "The mapping table"
description: "Every 0.x construct is catalogued, paired with a 1.0 target, and classed automatic, guided, or unsafe. This is what those classes decide and how a prop raises one."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/concepts/mapping.md"
---

The migration's decisions are data, not judgement. Two tables carry them, and
you can read both before you run anything.

## The catalog

`Constructs.constructs` is the catalog of everything application code can
import from the 0.x facade and from `@smthrs/components`. Each row names the
construct as source writes it, its kind, and the file in the Smithers 0.x
source tree that defines it. That last field is what makes a decision
auditable: you can check the claim against Smithers 0.35.0 rather than take the
tool's word for it.

The kinds are `component`, `ctx`, `factory`, `tool`, `agent`, `runtime`,
`store`, `server`, `testing`, `subpath`, `pragma`, `config`, `cli`, and
`value`. A `component` row also lists the props the old component declared,
because a prop is what can raise a construct's class.

Two halves of the catalog are read out of the Smithers 0.x source rather than
written by hand: every value the old facade exports, and the props each
`<Name>Props.ts` declares. A name that is missing from the catalog is a name
the scanner drops, and the old surface is too large to keep by hand. An
imported name with no catalog row raises `uncatalogued-import` instead of
vanishing.

## The mapping rows

`Mapping.rows` pairs every catalogued construct with a target, the module that
target lives in, the rule that governs the rewrite, and a class. The complete
table, several hundred rows, is in the [API reference](/reference/api/), rendered
from `Mapping.rows` itself.

## The three classes

| Class       | What it means                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `automatic` | The tool emits the exact rewrite text and the model applies it.                                                  |
| `guided`    | The model rewrites under the row's rule and records the decision it made.                                        |
| `unsafe`    | There is no honest automatic rewrite. `apply` refuses the unit until you name the construct in `--allow-unsafe`. |

An `unsafe` construct is refused rather than approximated. Even with
`--allow-unsafe`, the rewrite leaves a `TODO(migrate-smithers-v1): <construct>`
marker and an `unsupported` entry in the report instead of writing an
imitation. See
[Accept constructs with no safe translation](/guides/allow-unsafe-constructs/).

## A prop raises the class

The class belongs to the occurrence, not only to the construct.
`Mapping.classify(hit)` reads one inventory hit and its props;
`Mapping.classifyWithReason(hit)` adds why:

- `<Parallel>` is `automatic`.
- `<Parallel maxConcurrency>` is `guided`.
- `<Task hijack>` is `unsafe`.
- `<Approval allowedUsers>` or `<Approval allowedScopes>` is `guided`, including
  when both restrictions are present. The decorator has no equivalent fields.
  The operator must supply an approval flow that preserves the original user
  and scope restrictions; no automatic snippet is emitted.
- `<Loop maxIterations={Infinity}>` is `guided`, with the reason attached:
  bounded recursion needs a bound, and the migration has to choose one.

When one file holds a `<Task>` and a `<Task hijack>`, the report's row for
`Task` carries the worst class either occurrence has and the union of their
reasons, whichever one the scan read last.

## The rewrite text

`Mapping.snippet(hit)` returns the rewrite for a hit whose construct is
`automatic`: a compilable fragment carrying that hit's own identifiers, not a
whole file. It returns nothing for everything else, and the model works from
the rule instead.

Compilable is meant literally. A step id that would start with a digit is
prefixed, so `1st` becomes `Step1st`. Every key, tag, and seat is quoted. A
step group whose ids would fold to one identifier, such as `a-b` and `a_b`, is
refused rather than silently collapsed. A `Timer` duration is emitted as a
number of milliseconds or a duration string, and refused when it is an
expression.

## Schemas and prompts

Two scanners convert the parts of a project that are data rather than topology.

`ZodSchemaHints` converts the safe zod subset to `effect/Schema` text.
`z.object`, `z.string`, `z.number`, `z.boolean`, `z.array`, `z.enum`,
`z.literal`, `z.union`, `z.record`, `z.int`, `.optional()`, `.nullable()`,
`.default()`, `.describe()`, and the numeric and length checks all have exact
equivalents. The printer refuses rather than approximates whatever it cannot
say with the same meaning, and `.passthrough()`, `.refine()`, `.transform()`,
`z.discriminatedUnion`, `z.lazy`, `z.tuple`, and custom error maps are all
`guided`, because they carry behavior a text rewrite cannot preserve.

`PromptHints` turns an interpolation-only MDX prompt into a template-literal
body: each `{props.x}` becomes `${payload.x}`, and backticks, backslashes, and
`${` are escaped so the prose survives. A prompt that imports a module or
renders a component is classed `jsx`, and the model decides what it becomes.

## Decisions the tool refuses to make for you

Four constructs are always yours: `ClaudeCodeAgent`, `CodexAgent`,
`OpenCodeAgent`, and `fallbackAgents`. Each hit becomes an `unresolved` entry
in the report offering the same two options, subscription auth through the
flows harness or an API seat, and each says that a pool stays a pool. The
rewrite is forbidden to collapse an agent pool into a single seat, because
which subscriptions a project spends is not a decision a migration gets to
make.
