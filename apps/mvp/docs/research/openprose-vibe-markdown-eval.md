# OpenProse conventions in Smithers and VibeLang

Adopt structured prose as an authoring convention for prompt-backed workflows. Keep execution topology, privileges, and admission in the typed flow and host. Evaluate an adapter only when a real workflow needs machine-readable section data. [OpenProse Contract Markdown](https://github.com/openprose/prose/blob/main/skills/open-prose/contract-markdown.md)

## What the code does

- [Core lowering](../../../../packages/smithers/flows/core/src/Markdown.ts) takes already-parsed metadata and a body string. It forwards the body as one prompt, defaults to model `smart`, and builds an action-backed flow with `{ args: string }` and a string result. It normalizes capabilities and validates effects, budget, placement, and sandbox selection. An explicit empty capability list sets a ceiling.
- [Registry discovery](../../../../packages/smithers/agent/registry/src/Discovery.ts) recognizes `flow.ts`, `flow.vibe`, `flow.mdx`, and `SKILL.md`, in that precedence. For a plain Markdown workflow use `SKILL.md` and its skill metadata. An arbitrary `review.md` does not become a workflow entry. In the [VibeLang app Markdown renderer](../../../../apps/vibelang/src/web/markdown.vibe), headings, lists, and fences are presentation nodes.
- A `flow.vibe` can import a `prompt.mdx` with a `prompt.d.mdx.ts` declaration. [Executable loading](../../../../packages/smithers/agent/registry/src/Executable.ts) compiles the prompt to a text-rendering module and includes its dependencies and declaration in the measured closure. This is a separate entry path from a standalone Markdown flow. [Typed MDX guide](../../../../packages/smithers/agent/registry/docs/guides/mdx-prompts.md)
- OpenProse gives sections such as `Requires`, `Maintains`, and `Continuity` executable meaning. Forme connects declared facets and the VM schedules renders from input, cadence, or external wakes. Functions use parameters and returns with an isolated render. Some contracts include ProseScript for explicit control flow. [OpenProse language overview](https://github.com/openprose/prose/blob/main/README.md) · [VM specification](https://github.com/openprose/prose/blob/main/skills/open-prose/prose.md)

| Convention | Decision | Smithers implementation |
| --- | --- | --- |
| Clear goal, inputs, output, and examples | Adopt | Use repeatable headings in `SKILL.md` and `prompt.mdx`. Preserve body bytes at the lowering boundary. |
| Parameters and returns | Adapt | Keep a Markdown entry for string-in/string-out. Use Effect Schema in `flow.vibe` and concrete MDX props when callers require structured inputs or outputs. |
| Postconditions and material facets | Adapt | Use checks in the action before publishing and expose typed results. Add tests that reject an invalid result before it becomes a downstream input. Prompt-level checks guide the model. |
| Requires/Maintains wiring and wake rules | Adapt | Declare edges and timers in the typed graph and scheduler. A future importer should report unresolved or cyclic edges before any run. |
| ProseScript loops and implicit runtime activation | Reject for M2 | Express retries, fan-out, and waits in the durable graph. Discovered prompt text carries no scheduling or approval authority. |
| Executable MDX supplied as documentation or chat | Reject | Keep untrusted content on the rendering path. Reserve MDX expression execution for measured, trusted workflow modules. |

## Runnable examples

Run from the repository root. The first example feeds a plain Markdown skill into the parser and lowerer, checks the resulting flow, and prints its tag and preserved body. The heading and list are regular prompt content.

```sh
node --input-type=module <<'JS'
import assert from "node:assert/strict"
import { parseSkill, lowerMarkdown } from "./packages/smithers/flows/core/src/Markdown.ts"

const text = "---\nname: review\ndescription: Summarize a change.\n---\n\n# Goal\n\n- List concrete findings."
const parsed = parseSkill(text)
assert.equal(parsed._tag, "Success")
const { body, ...metadata } = parsed.success
const lowered = lowerMarkdown({ ...metadata, name: "review", capabilities: [] }, body)
assert.equal(lowered.flow._tag, "review")
assert.equal(lowered.prompt.trim(), "# Goal\n\n- List concrete findings.")
assert.deepEqual(lowered.capabilities, [])
console.log(lowered.flow._tag)
console.log(lowered.prompt.trim())
JS
```

```text
review
# Goal

- List concrete findings.
```

The second example uses the existing strict VibeLang fixture. It writes a `flow.vibe`, an MDX component, and its declaration, then discovers, compiles, and executes the flow with `{ args: "packages" }`. It checks the output below, rejects a declaration changed after measurement, and rejects a newly measured declaration with incompatible props. [Runnable fixture](../../../../packages/smithers/agent/registry/test/fixtures/mdx-vibe-runner.mjs)

```sh
node --import vibelang/register packages/smithers/agent/registry/test/fixtures/mdx-vibe-runner.mjs
```

```markdown
# Review

Inspect **packages**.
```

A passing fixture prints `{"runtime":"vibe-mdx","assertions":"passed"}`. The fixture exercises Smithers discovery and VibeLang compilation. OpenProse execution is outside this comparison.
