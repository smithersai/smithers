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
| A string-literal union member spelled `""` gets a valid Dafny constructor name, and one spelled `none` stays the union's own constructor rather than Option's `None` | Offered upstream later |
| A string-literal union value widens where TypeScript allows it: to a `string` slot, and to a union holding all of its members, in arguments, fields, returns and `==` | Offered upstream later |
| A `<T extends Bound>` parameter inside a type expression (`ReadonlyArray<T>`, `readonly T[]`) reads as its bound, and an array-wrapped signature type keeps its declaration | Offered upstream later |
| A constant imported by name from another module (`import { LIMIT as L }`) is declared with its value, with the constants its initializer reads; a name that collides with another constant is refused | Offered upstream later |
| `//@ safe-slice` also clamps one-argument array slices and every string slice like JavaScript (`safe-slice-suffix.ts`) | Offered upstream later |
| A two-parameter `map` callback binds the element's index (`map-index.ts`) | Offered upstream later |
| A record field declared `real` (`type real = number`) is a Dafny `real`; it was an integer, which proved false claims about fractional values (`real-field.ts`) | Offered upstream later |
| A generic interface or object alias keeps its type parameters (`generic-record.ts`) | Offered upstream later |
| A Foldkit `const X = defineMessageUnion({ Tag: { field: Schema.X } })` is read as a `_tag` union with a typed `X.match`, so the table and its arms are proved; payload fields read are `Schema.String`, `Number`, `Boolean`, `Literal`, `Literals`, `Array`, `optionalKey` and a schema named by an identifier that is also its type, and any other is refused by name (`message-union.ts`, `tools/src/message-union.ts`) | Offered upstream later |
| A type named by an import is read from its declaration, and a project's own `.d.ts` (not `node_modules`) is user code: a tagged union in a module's emitted declaration, imported with `import type`, is a datatype rather than an abstract type (`declared-union/`) | Offered upstream later |
| A sorted copy (`[...xs].sort(cmp)`, `.sort()`) states membership in both directions as well as the permutation, so `xs.includes(r[i])` and `r.includes(xs[i])` are provable (`sort-membership.ts`) | Offered upstream later |
| A filtered list states its predicate and membership for each element by index (`r[i]`), proved from the local `SeqFilter`'s body under `dafny-library: local` (`filter-index.ts`) | Offered upstream later |

Each patch is offered back upstream later. Will decides any GitHub contribution.

## Check

`pnpm --filter @smthrs/lemmascript build`, then `pnpm --filter @smthrs/lemmascript test`. The fixtures need `dafny` on
`PATH`; `apps/vibelang/verify/.tools/bin` has it.

Proof harnesses consume `Package.compilerSources` from `PACKAGE.ts` (`//packages/lemmascript:compilerSources`)
as a data dependency. This keeps compiler changes in their cache identity while each package owns its source globs.
