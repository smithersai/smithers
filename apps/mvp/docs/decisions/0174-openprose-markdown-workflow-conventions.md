# Decision 0174: OpenProse conventions for Markdown and MDX workflows

Status: Accepted (2026-11-25)

## Context

Smithers supports code workflows in `.smithers/workflows/<name>.vibe` (Decision 0171), plain Markdown skills via `SKILL.md` lowered by `packages/smithers/flows/core/src/Markdown.ts`, and typed MDX prompt modules imported by `.vibe` workflows through `packages/smithers/agent/registry/src/Executable.ts`. During M2 planning we evaluated OpenProse Contract Markdown (`openprose/prose`) to decide which conventions belong in Smithers and VibeLang.

## Decision

1. **Adopt structured prose conventions for prompt authoring.** Use repeatable headings (`Goal`, `Inputs`, `Output`, `Postconditions`, `Examples`) inside `SKILL.md` and `prompt.mdx` modules while preserving raw body bytes across the lowering boundary.
2. **Keep topology, scheduling, and privileges in typed VibeLang code.** Do not adopt ProseScript loops or implicit runtime wake rules in Markdown. Retries, fan-out, waits, and capability ceilings stay in typed `Flow.make` definitions and Effect Schemas.
3. **Keep untrusted Markdown non-executable.** Arbitrary documentation or chat Markdown renders strictly as data. Executable MDX expressions remain confined to measured, repository-declared workflow modules with declaration parity checks (`prompt.d.mdx.ts`).

## Consequences

- Plain `SKILL.md` workflows remain string-in, string-out with explicit capability ceilings (`capabilities: []` sets an empty ceiling).
- Structured workflows use `.vibe` with typed `prompt.mdx` imports and fail closed on declaration tampering or incompatible props.
- See the detailed engineering evaluation in [openprose-vibe-markdown-eval.md](../research/openprose-vibe-markdown-eval.md).
