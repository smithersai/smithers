---
title: "Declared authority"
description: "How capabilities become an effect declaration and a reversibility tier, when a declaration projects the conservative wildcard, and what the tier decides downstream."
sidebar:
  order: 3
---

Every descriptor carries an `EffectDeclaration`: the paths the flow reads, the
paths it writes, whether those two sets are complete, what to do when two runs
collide, and a reversibility `tier`. Discovery derives all five without
evaluating anything, which is the constraint that shapes every rule here.

## The three tiers

| Tier           | What it claims                                                 |
| -------------- | -------------------------------------------------------------- |
| `sealed`       | Nothing has to be undone. Reading a file, a GET, a model call. |
| `compensable`  | Something was written, and the write can be reversed.          |
| `irreversible` | Neither of the above can be proven.                            |

The tier is inferred from the declared `capabilities` when the flow does not
state one. `fs:read`, `net:get`, `model:call`, `jj:status`, and `jj:diff`, plus
the bare tool names `read`, `grep`, `glob`, and `ls`, are sealed. A relative
`fs:write:<resource>` path is compensable. Everything else is irreversible, and
the inference takes the most conservative tier any one capability implies.

The compensable case is narrow on purpose. Only a relative path with no home
marker, no variable reference, and no URI scheme qualifies. `~/notes`,
`$HOME/notes`, `${HOME}/notes`, `%USERPROFILE%\notes`, `file:///notes`, an
absolute path, and a path that escapes the workspace with `..` are all
irreversible, because none of them can be checked back to a place the host
controls.

A flow may declare `effects.tier` itself. A declaration is accepted when it is
at least as conservative as the inference; one that under-classifies is
reported as `invalid_effect_tier` and the inference wins. An unrecognized value
becomes `irreversible` with the same warning.

## The conservative wildcard

When a markdown flow omits `capabilities`, or a module flow's capabilities
cannot be read statically, discovery projects wildcard capabilities `["*"]`,
wildcard `reads` and `writes` `["**"]`, `mode: "expected"`,
`onConflict: "serialize"`, and `tier: "irreversible"`. A declared `sealed` tier
on such a flow is reported as under-classifying rather than accepted.

Wildcard capabilities carry that whole projection, including when a flow
declares `capabilities: ["*"]`. A narrower `reads` or `writes` beside an
unbounded capability list is a claim discovery cannot check. A malformed
markdown `capabilities` value is refused with `invalid_capabilities`; it does
not produce a descriptor.

A member the declaration leaves out is read the other way. An `effects` object
discovery can read, with no `reads` key, declares an empty read set rather than
an unknown one, because the author wrote the object and left the list out. Only
a member discovery cannot read widens to the wildcard.

The case both body kinds share is a **non-empty `flows` list**. The flow
delegates to another flow, and that flow's authority is not statically visible,
so the delegate grant is the wildcard. A readable `capabilities` declaration is
the ceiling of that grant: the descriptor carries the intersection, so a
delegating flow that declares `["fs:read:**", "proc:spawn:sh -c *"]` runs with
those two and no more. A declaration only narrows the grant and never widens
it. A delegating flow that declares no `capabilities` keeps the wildcard, with
an `unprojectable_authority` warning.

The rest differ, because the two bodies say different things by staying silent:

| Situation                                        | Markdown flow                                                                                                                                                           | Module flow                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `capabilities` key                            | The wildcard, with an `unprojectable_authority` warning. A skill that says nothing about its authority is not a skill with none.                                        | An empty list, with no warning. A `Flow.make` value that omits the field declared no authority, which the module's own effects then describe.        |
| A `capabilities` value discovery cannot read     | A mapping or an array containing non-strings is refused with `invalid_capabilities`; no descriptor is produced. A space-separated string is accepted with this warning. | The wildcard, with `unsupported_module_metadata`. Anything but a string-literal array is unreadable without evaluating the module.                   |
| A spread or computed property in the declaration | Not expressible in YAML.                                                                                                                                                | The wildcard, with `unsupported_module_metadata`, because the object's real members are not visible in the source text.                              |
| A default export discovery cannot read at all    | Not applicable.                                                                                                                                                         | No descriptor. The `unsupported_module_metadata` warning says the declaration could not be read, and the missing description then refuses the entry. |

Every module-side diagnostic in that table arrives under the single code
`unsupported_module_metadata`, carrying the specific message in its `message`
field. The markdown side spends distinct codes, because a skill author reads
them one at a time.

## Why the tier is not cosmetic

The tier is an admission contract. `Executable.dispatchedAction` puts
`effects.tier` on the action a bridged flow dispatches, and
[`@smthrs/engine-store`](/api/engine-store)'s `ActionPersistence` reuses a
`sealed` dispatch and nothing else. Projecting an indirectly writing flow as
sealed would do two wrong things at once: cache its result as reusable, and
disclose it to a model as read-only.

That is why a descriptor that names a delegate flow and declares no
capabilities can declare a cache policy and still never have a result reused.
Its wildcard projects an `irreversible` tier, so its policy reaches admission
and is refused there. The descriptor whose result travels is the one whose own
capabilities project a `sealed` tier, with a `hermetic` effect declaration and
no globbed read set. See
[Reuse a discovered flow's result](../guides/reuse-a-flow-result.md).

## Budgets and deadlines

A markdown flow may declare the ceilings a control plane should approve for one
of its runs:

```yaml
---
description: Reviews a proposed change.
budget:
  tokens: 120000
  milliseconds: 900000
  usd: 2.5
---
```

`tokens` and `milliseconds` are positive safe integers and `usd` is a positive
dollar amount. They are the fields of a control-plane `Envelope.budget`, so a
host projects them into an approved envelope without reinterpreting any
number, and
[`@smthrs/agent`](/api/agent)'s `Budget.layerFromEnvelope` turns that envelope
into enforcement at the model boundary.

A markdown or module flow with a malformed budget is refused with
`invalid_budget`. Invalid ceilings, unknown keys, declarations with no ceiling,
and a `Flow.make` budget that is not a statically projectable object literal
never produce an unbounded descriptor. Correct the declaration before the flow can be listed.

An absent `budget` is not a zero. It is the absence of a ceiling, which
`Descriptor.budgetOf` answers with the named value
`Descriptor.budgetUnbounded`, so a host that gives up a ceiling can be seen to
have decided that rather than to have read an empty object. Every host builds
its envelope through `budgetOf` rather than by reading the field.

A top-level `deadline` joins the budget as `budget.deadline`, in whole
milliseconds: the wall-clock time one run may take, counted from its first
start, written as a duration (`deadline: 30 minutes`) or milliseconds. The
control plane enforces it for the whole run, every trampoline round included,
and expiry fails the run whatever `onExceeded` says. An unreadable explicit deadline refuses the markdown descriptor with
`invalid_deadline`.

A module flow declares the same keys as a `Flow.make` literal,
`budget: { tokens: 200000, milliseconds: 600000 }`. Discovery reads the literal
from the source text without evaluating the module;
its warnings name `Flow.make budget`. A budget that is not an object literal,
or a member that is not a literal value, is dropped with a warning. A module's
`deadline` is the flow's own `Flow.make` deadline, which the flow runtime
enforces, so it never joins `budget.deadline`.

## Reading it back

- [Descriptors](./descriptors.md): the value all of this lands in.
- [Delegation](./delegation.md): what the declaration lowers onto at runtime.
- The [flow.mdx reference](/docs/reference/flow-mdx/): every frontmatter key an
  author may write.
