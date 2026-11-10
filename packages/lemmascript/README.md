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
| `//@ opaque` emits a Dafny `opaque function`: a non-recursive one carries its contract on the function, a recursive one keeps it on its companion lemma, which reveals the body; `//@ reveal f` reveals opaque `f` at the start of another function's proof (`opaque-measure.ts`) | Offered upstream later |
| A contract copied from another module declares that module's constants it names, with the same collision check as a named const import; constants with the same name from different contracts are also refused (`imported-contract-const/`, `imported-contract-const-cross-collision/`) | Offered upstream later |
| `//@ safe-slice` also clamps one-argument array slices and every string slice like JavaScript (`safe-slice-suffix.ts`) | Offered upstream later |
| A two-parameter `map` callback binds the element's index (`map-index.ts`) | Offered upstream later |
| A record field declared `real` (`type real = number`) is a Dafny `real`; it was an integer, which proved false claims about fractional values (`real-field.ts`) | Offered upstream later |
| A generic interface or object alias keeps its type parameters (`generic-record.ts`) | Offered upstream later |
| Return-only generic record declarations stay in extraction; conditional spreads retain explicitly built fields and treat an absent field as undefined, without constructing an underspecified partial generic record (`generic-return-interface.ts`, `generic-optional-spread.ts`, each with a wrong twin) | Local fix with regression fixtures |
| A Foldkit `const X = defineMessageUnion({ Tag: { field: Schema.X } })` is read as a `_tag` union with a typed `X.match`, so the table and its arms are proved; payload fields read are `Schema.String`, `Number`, `Boolean`, `Literal`, `Literals`, `Array`, `optionalKey` and a schema named by an identifier that is also its type, and any other is refused by name (`message-union.ts`, `tools/src/message-union.ts`) | Offered upstream later |
| A type named by an import is read from its declaration, and a project's own `.d.ts` (not `node_modules`) is user code: a tagged union in a module's emitted declaration, imported with `import type`, is a datatype rather than an abstract type (`declared-union/`) | Offered upstream later |
| A sorted copy (`[...xs].sort(cmp)`, `.sort()`) states membership in both directions as well as the permutation, so `xs.includes(r[i])` and `r.includes(xs[i])` are provable (`sort-membership.ts`) | Offered upstream later |
| A filtered list states its predicate and membership for each element by index (`r[i]`), proved from the local `SeqFilter`'s body under `dafny-library: local` (`filter-index.ts`) | Offered upstream later |
| Dafny names `assigned`, `hide` and `ORDINAL` are escaped like other reserved words | Offered upstream later |
| Bare `forall` and `exists` identifiers remain names; only a following `(` starts a contract quantifier (`quantifier-names.ts`) | Offered upstream later |
| String casing is exact on ASCII strings and unconstrained on non-ASCII strings; false Unicode value/length claims must fail (`string-case*.ts`) | Offered upstream later |
| Array-valued `flatMap` callbacks use the existing ordered map and one-level flatten model, including a literal callback’s index and receiver/name hygiene (`flat-map.ts`) | Offered upstream later |
| Contract arrays may spread array values between literal groups, preserving their order through the executable array-concat IR (`spec-array-spread.ts`) | Offered upstream later |

Each patch is offered back upstream later. Will decides any GitHub contribution.

## Check

`pnpm --filter @smthrs/lemmascript build`, then `pnpm --filter @smthrs/lemmascript test`. The fixtures need `dafny` on
`PATH`; `apps/vibelang/verify/.tools/bin` has it.

Proof harnesses consume `Package.compilerSources` from `PACKAGE.ts` (`//packages/lemmascript:compilerSources`)
as a data dependency. This keeps compiler changes in their cache identity while each package owns its source globs.

Generic union match lowering resolves the base declaration while retaining the instantiated scrutinee type. Both pure and imperative Value/Empty branches are covered by generic-union-match and its false twin; the function and declaration use different generic parameter names.

The optional-spread regression also reconstructs optional record fields: after path narrowing substitutes a present payload binder, optional wrapping uses the refined payload type, so Some is retained exactly once.
