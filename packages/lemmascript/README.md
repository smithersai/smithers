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
| Tool modules and exported contracts carry the repository JSDoc headers, version tags, and categories; compiler behavior is unchanged | Local only |
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
| `Math.max(a, b)`/`Math.min(a, b)` with a `real` operand compare as reals, and an integer branch of a real conditional is lifted to `real` (`real-minmax.ts`) | Offered upstream later |
| A type written as, or derived from, an Effect Schema (`type Model = typeof Model.Type` over `Schema.Struct`, `optionalKey`, `optional`, `Array`, `Record`, `Union` of `TaggedStruct`s, `brand`, `withDecodingDefaultKey`) is read from the value type the checker resolves, from the schema's source or from its emitted `.d.ts`, never from the schema's type text. An anonymous object, array element, record value or tagged union becomes a named datatype (`ModelRowsItem`, `ModelStatus`), and structurally equal ones share one, a schema's own alias included (`type Client = typeof Client.Type` and a Model field holding a copy of it are one datatype); an optional key is `Option` under `exactOptionalPropertyTypes` too; a brand is its primitive; an untagged union is an opaque type of its own; a function returning the alias returns its datatype; and a schema constant named only as a type stays out of the model (`schema-model/`, with a wrong twin, and `tools/tests/schema-model.test.ts`) | Offered upstream later |
| A resolution error names its function and the innermost line (`resolve-location.test.ts`) | Offered upstream later |
| `x ?? null` and `x ?? undefined` keep x's optional type (`nullish-null-default.ts`) | Offered upstream later |
| A destructured anonymous record, its rest binding and an inline record parameter are declared records; record rest destructuring lowers to field reads (`destructured-nested-record.ts`) | Offered upstream later |
| A computed parameter type (`NonNullable<M["f"]>`, an indexed access, `typeof`) is the type it resolves to, and an unannotated object literal local is a record (`nonnullable-record.ts`, `local-record.ts`) | Offered upstream later |
| A generic alias over an indexed type (`WithCommands<R>`) is instantiated per use as a record; a spread whose override changes the record type builds the target record, reading the spread once; generic type arguments are emitted as types (`computed-record-alias.ts`) | Offered upstream later |
| A tagged match inside an expression, immediately invoked arrows, statement-valued match arms, and `&&`/`||`/conditional branches that need statements keep JavaScript's evaluation order and short-circuit (`tagged-match-expression.ts`, `tagged-match-method.ts`) | Offered upstream later |
| String-literal unions with the same members are one enum datatype however written, a literal-union local takes its initializer's type, and a record widens to one with extra optional fields (`literal-union-identity.ts`, `record-widening.ts`) | Offered upstream later |
| `tools/test-fixtures.sh` runs the package's own `tsx` and `tsc` rather than `npx`, which exits with `EINVALIDTAGNAME` on this monorepo's pnpm override keys | Local only |
| A `k in m` on the left of `&&` or `==>` narrows `m[k]` on the right to the value, as `if (k in m)` does, so a lookup can index a sequence (`items[m[k]]`); and a contract's `m.keys()` is the map's key set (Dafny `m.Keys`), so a loop can decrease `m.keys() - seen`, a set that shrinks until the walk ends (`map-set.ts`, `tests/map-set.test.ts`) | Offered upstream later |
| A presence check on the left of a boolean `&&` binds the value on the right (`r != undefined && r.length == 0`), and a top-level contract conjunction is split into clauses only before its first presence check or `k in m`, which keep the conjuncts after them; a premise, a condition, a longer chain and a right side that already matches on the value (`x != undefined && (x ?? d) == d`) keep their existing rules (`tests/map-set.test.ts`) | Offered upstream later |
| A record or array literal as the default of `??` builds the left operand's type; it took the enclosing function's return type (`map-set.ts` `walked`) | Offered upstream later |
| A spread whose field is required over a record where it is optional (`{ ...panel, ...selection }`, `step: string` over `step?: string`) writes the present value; it was matched as an Option (`spread-required-into-optional.ts`, with a wrong twin) | Offered upstream later |
| A rest binding of a parameter or variable written with a named type (`const { sandbox, ...kept } = model`, `model: Model`) keeps that type; the checker's anonymous type of a schema alias was named from the binding (`Destr0`) and took the alias's place, so an imported contract that narrows an optional field of `Model` failed to resolve (`schema-model/rest.ts`, with a wrong twin) | Offered upstream later |
| String `lastIndexOf(sub)`: the last match or -1 (an empty `sub` at the end), with no later match stated over slice bounds and, for one code unit, per `charCodeAt`; a position argument and the Lean back end are refused by name (`string-last-index.ts`, with a wrong twin) | Offered upstream later |
| `x === undefined || P(x)` reads `x` narrowed on the right, one match per leading absence fact; a disjunction that never reads `x`, or only compares it directly, keeps its shape (`optional-or-narrowing.ts`) | Offered upstream later |
| Inside the arm that bound an optional, a presence check on it is a constant, and a loop's `decreases` and `doneWith` read the bound value (`narrowed-presence.ts`) | Offered upstream later |
| `//@ assert forall(i, A ==> exists(k, B)) by exists(k, C)` proves a forall-exists in a method: a Dafny forall statement fixes `i`, picks `k :| C` and checks B for it. The goal's body `A ==> exists k :: B` becomes a predicate over its free variables, shared by the method's requires and ensures clauses with the same body (and by a precondition whose `exists` part is the pick's), with each `X[i]` kept as an alternative trigger. Without the name, Z3 skolemizes the negated goal to `i0` and finds no ground term to instantiate the fact with (`apps/vibelang/verify/bugs/forall-exists-witness.dfy`). Methods only; Lean refuses it (`forall-exists-witness.ts`, its `-red` and `-wrong` twins) | Offered upstream later |

A guarded optional record, or an already non-nullable record/primitive, may use a redundant nullish fallback in a
contract (`spec-nullish-narrowed.ts`). Narrowing keeps the present value, including zero, false and the empty string.
Array indexes retain their bounds-dependent fallback. The wrong guarded-result and falsy-value twins must fail a
Dafny postcondition. Unknown, opaque and nullable types do not acquire a presence assumption.
| `pattern.test(s)` on a literal pattern, or a module `const` holding one, is decided by a Dafny matcher (Brzozowski derivatives) proved equal to the pattern's language, and `test` to "some substring with the anchored ends is in it" (`JsTestCorrect`). A contract names a test with `\\matches("pattern", s)`. The subset: code units, `.`, classes and `\\d \\w \\s` with their negations, groups, alternation, `* + ? {m} {m,} {m,n}` (lazy too), `^` first and `$` last, no flags. Everything else (flags, `\\b`, lookaround, backreferences, `exec`, `match`, `replace`) is refused by name, except `s.split(/re/)`, an opaque extern of `s` per pattern (`update-returns/`). Dafny backend only (`tools/src/regex.ts`, `regex.ts`, `regex-wrong.ts`, `tests/regex.test.ts`, which also compares the subset's semantics with the native RegExp) | Offered upstream later |
| A pure function's contract reaches its callers: Dafny holds it on the companion lemma `f_ensures`, which nothing called, so a caller knew only `f`'s body. Each call evaluated unconditionally (not under `&&`, `\|\|`, `==>`, a branch, a quantifier or a lambda) in a function body, a statement or a companion lemma is now preceded by `f_ensures` with the same arguments; a companion lemma also visits short-circuit right operands under their evaluation guards, so a callee's preconditions hold there; in a companion lemma each such call is a hint under the callee's preconditions (`if (pre) { f_ensures(...); }`), so it adds no failure site: an unguarded call outside the domain let Dafny assume its ensures and prove a wrong body's lemma; a recursive function's body skips its own lemma, and its lemma calls itself under the function's `decreases` (`contract-callers.ts`, with a wrong twin, `tests/contract-callers.test.ts`) | Offered upstream later |
| TypeScript's structural types: a record or tagged union LemmaScript synthesized is the declared type of the same structure; a record passes where a record with a subset of its fields is expected, in a list element by element; an imported function's arguments are coerced to its parameters; a bodiless `declare const` in a project's own `.d.ts` is a fixed value of its type, and a value with a type of the same name is the type (`structural/`, with a wrong twin, `tools/tests/structural.test.ts`) | Offered upstream later |
| Every object type a package's typings declare is one opaque `Host`; a host alias of a plain object type (Foldkit's `Update.Return`) is a record with its `never` fields dropped; a value a project's own `.d.ts` declares (a Foldkit command) is an opaque extern of a record of its arguments (`{}` is the empty record); a type named through a namespace import is its declaration (`host-extern/`, with a wrong twin) | Offered upstream later |
| `Message.Tag(payload)` is its variant; `s.split(/re/)` and a pure string method LemmaScript does not model (`toWellFormed`, `padStart`) are opaque externs; a string-union value takes string methods and `.length`; another module's constant of an anonymous type (a generated table) is a fixed unknown value; a copied constant's own type is declared; a function, extern or constant whose name a type also declares is emitted as `Name_value` (`update-returns/`, eight wrong twins) | Offered upstream later |
| A match arm may bind the whole payload; `x === undefined \|\| rest ? a : b` matches on `x`; a field path a false absence check proves present is narrowed in the else-branch and after an early return; a constant read through a namespace import is copied; an extern's anonymous result is a record the structural merge matches (`update-shapes/`, `optional-path-else.ts`, each with a wrong twin) | Offered upstream later |

Safe-slice contracts expose both native past-end emptiness and equality to a bounded raw slice, so a checked
callee consuming a suffix can retain its character relation (`safe-slice-suffix.ts`, `ownPost`). The native
prefix/serial table in `safe-slice-suffix.test.ts` covers shorter, foreign and valid session ids.

Each patch is offered back upstream later. Will decides any GitHub contribution.

## Check

`pnpm --filter @smthrs/lemmascript build`, then `pnpm --filter @smthrs/lemmascript test`. The fixtures need `dafny` on
`PATH`; `apps/vibelang/verify/.tools/bin` has it. The Effect Schema fixtures resolve `effect` from this package's
`devDependencies`, at the monorepo's version.

Proof harnesses consume `Package.compilerSources` from `PACKAGE.ts` (`//packages/lemmascript:compilerSources`)
as a data dependency. This keeps compiler changes in their cache identity while each package owns its source globs.

Generic union match lowering resolves the base declaration while retaining the instantiated scrutinee type. Both pure and imperative Value/Empty branches are covered by generic-union-match and its false twin; the function and declaration use different generic parameter names.

The optional-spread regression also reconstructs optional record fields: after path narrowing substitutes a present payload binder, optional wrapping uses the refined payload type, so Some is retained exactly once.

Dafny method lowering keeps Boolean short-circuit right-operand calls under their evaluation guards, including their argument reads. The contract-callers fixture and emission regressions cover guarded string indexes.

Dafny conditional expressions also keep lifted calls and their argument reads inside their selected branch. Both branches assign the typed result; no unselected call is evaluated. Guarded then/else index fixtures cover this lowering.

Unary minus on a natural value is signed. Conditional arms joining natural and signed integers use the signed type in either order, so typed guarded temporaries preserve negative branches.
