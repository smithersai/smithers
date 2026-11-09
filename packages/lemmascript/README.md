# @smthrs/lemmascript

LemmaScript generates Dafny or Lean 4 from annotated TypeScript. This package is a copy of LemmaScript so we can fix the
tool where a proof needs it. `apps/vibelang/verify` runs it.

## Attribution

Copied from [midspiral/lemmascript](https://github.com/midspiral/lemmascript), tag `v0.6.6`, commit
`736fb7ce5ef89555b566bdbcca0c8fe057fbb205`. MIT licensed by its authors; see `LICENSE`. `tools/` and the examples its
tests read are unchanged except for the patches listed below.

## Patches

| Patch | Status |
| --- | --- |
| `lsc claimcheck` is optional: this copy does not depend on `lemmascript-claimcheck`, and the subcommand reports it missing | Local only |
| Object spread of a conditional over two object literals (`...(c ? { a: 1 } : { b: 2 })`) field by field | Offered upstream later |
| Object spread of a value holding a strict subset of the base record's fields | Offered upstream later |
| A contract record literal may begin with a spread (`\\result == { ...state, f: v }`), and a contract record or array literal on the right of `==` takes the left operand's declared type | Offered upstream later |
| An exhaustive `X.match(value, { Tag: ({ field }) => result })` table over a `_tag` union, in return position, read as a `switch` | Offered upstream later |

Each patch is offered back upstream later. Will decides any GitHub contribution.

## Check

`pnpm --filter @smthrs/lemmascript build`, then `pnpm --filter @smthrs/lemmascript test`. The fixtures need `dafny` on
`PATH`; `apps/vibelang/verify/.tools/bin` has it.

Proof harnesses consume `Package.compilerSources` from `PACKAGE.ts` (`//packages/lemmascript:compilerSources`)
as a data dependency. This keeps compiler changes in their cache identity while each package owns its source globs.
