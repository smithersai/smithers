---
title: "Load an Agent Skill as a flow"
description: "Parse a SKILL.md document, validate its frontmatter against the Agent Skills specification, and lower a markdown prompt into an ordinary flow."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/load-an-agent-skill.md"
---

An Agent Skill is a markdown document with YAML frontmatter. This package
parses one, checks it against the intrinsic rules of the
[Agent Skills specification](https://agentskills.io/specification), and lowers
it into an ordinary `Flow`. The one rule that needs the file system, that
`name` must equal the skill directory name, stays with
[`@smthrs/registry`](https://registry.smithers.sh/reference/api/).

## Parse a document

```ts
import { Markdown } from "@smthrs/core"
import * as Result from "effect/Result"

const document = `---
name: release-notes
description: Draft release notes from a changelog.
allowed-tools: read write
license: MIT
---

Summarize the changelog for the release.
`

const parsed = Markdown.parseSkill(document)
console.log(Result.getOrThrow(parsed))
```

On success the value is a `SkillDocument`:

```text
{
  name: 'release-notes',
  description: 'Draft release notes from a changelog.',
  allowedTools: [ 'read', 'write' ],
  extra: [Object: null prototype] { license: 'MIT' },
  body: '\nSummarize the changelog for the release.\n'
}
```

`allowedTools` is the specification's space-separated `allowed-tools` scalar,
split into tool names. `extra` holds every other frontmatter field, including
the validated optional `license`, `compatibility`, and `metadata`, as a frozen
null-prototype record. Frontmatter is parsed with the failsafe YAML schema, so
every scalar arrives as a string and nothing is coerced behind your back.

## Lower it to a flow

```ts
const lowered = Markdown.lowerSkill(document)
```

The result is a `Flow` whose input is `{ args: string }` and whose output is
`string`. Only `name`, `description`, and `allowed-tools` are lowered:

| Frontmatter     | Becomes                                 |
| --------------- | --------------------------------------- |
| `name`          | The signature's name, which is its tag. |
| `description`   | The flow's description.                 |
| `allowed-tools` | The flow's declared collaborators.      |
| the body        | The flow's prompt.                      |

Everything else stays in `extra` for the caller to interpret. Coercing a field
such as `model` or `placement` here would duplicate the flow-level frontmatter
typing that `@smthrs/registry` owns.

The lowered signature has no body, so it carries the action a host supplies the
implementation for, and the seat, the collaborators, and the prompt travel
beside it as the declaration that host reads. A skill that declares no `model`
gets the explicit `smart` fallback seat.
Harnesses append non-empty runtime `args` when they render the prompt, which is
the markdown-flow calling convention.

## Lower already-parsed metadata

When you have parsed the frontmatter yourself, and typed it, `lowerMarkdown`
takes the metadata and the body directly. It reads more fields than
`lowerSkill` does, because its input is typed rather than failsafe YAML:

```ts
const flow = Markdown.lowerMarkdown({
  name: "release-notes",
  description: "Draft release notes from a changelog.",
  model: "smart",
  flows: ["read", "write"],
  capabilities: ["fs:read"],
  effects: { reads: ["CHANGELOG.md"], writes: [], mode: "hermetic" },
  placement: "sandbox"
}, "Summarize the changelog for the release.")
```

`effects` defaults each omitted field: `reads` and `writes` to empty, `mode` to
`hermetic`, and `onConflict` to `serialize`. `placement` accepts `"sandbox"`,
`"remote"`, `"client"`, and `"local"`; omitting it leaves the flow unplaced.

## Validate frontmatter you already have

`Markdown.validateSkillFrontmatter` applies the specification's rules to a
record you parsed yourself, and returns the same lowered `SkillFrontmatter`:

```ts
const checked = Markdown.validateSkillFrontmatter({
  name: "release-notes",
  description: "Draft release notes from a changelog."
})
```

The rules it enforces:

| Field           | Rule                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `name`          | 1 to 64 lowercase ASCII letters, digits, or single hyphens, not starting or ending with a hyphen. |
| `description`   | 1 to 1024 characters, counted in code points.                                                     |
| `allowed-tools` | One space-separated scalar, when present.                                                         |
| `license`       | A scalar, when present.                                                                           |
| `compatibility` | 1 to 500 characters, when present.                                                                |
| `metadata`      | A mapping from string keys to scalar values, when present.                                        |

Characters are counted in code points, not UTF-16 units, so a 600-emoji
description the specification accepts is accepted here too.

## The failure codes

Every loader failure is a `Result.fail` carrying a `MarkdownError` with a
stable code and a message. No message echoes the offending value, so a bad
frontmatter field cannot smuggle text into your logs. Both `parseSkill` and
`lowerSkill` return `skill_invalid_frontmatter` for YAML parsing or conversion
failures, including unresolved aliases, forward aliases, and exceeded alias
expansion limits. Conversion exceptions use a fixed message without source
text or the raw exception message. YAML's alias expansion protection stays
enabled.

| Code                          | Cause                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| `skill_missing_frontmatter`   | The document has no leading frontmatter block.              |
| `skill_invalid_frontmatter`   | The frontmatter cannot be parsed or converted from YAML.    |
| `skill_missing_name`          | `name` is absent or blank.                                  |
| `skill_invalid_name`          | `name` breaks the grammar or exceeds 64 characters.         |
| `skill_missing_description`   | `description` is absent or blank.                           |
| `skill_invalid_description`   | `description` is not a scalar, or exceeds 1024 code points. |
| `skill_invalid_allowed_tools` | `allowed-tools` is not a scalar.                            |
| `skill_invalid_license`       | `license` is not a scalar.                                  |
| `skill_invalid_compatibility` | `compatibility` is not a scalar of 1 to 500 characters.     |
| `skill_invalid_metadata`      | `metadata` is not a mapping to scalar values.               |

Handle them like any other `Result`:

```ts
if (Result.isFailure(parsed)) {
  console.error(parsed.failure.code, parsed.failure.message)
}
```

```text
skill_invalid_name SKILL.md name must be 1 to 64 lowercase ASCII letters, digits, or single hyphens, and cannot start or end with a hyphen
```

## Where to go next

- [Declare a flow](/guides/declare-a-flow/): what a lowered flow is made of.
- [Troubleshooting](/troubleshooting/): every failure this package
  produces, in one place.
