# LemmaScript 0.6.6 backend reproductions

All four files strictly typecheck. `pnpm verify verify/bugs/<name>.ts` fails before proof checking: three during
Dafny resolution and `array-literal-map.ts` during emission. They are tool bugs, not successful negative-contract
tests; no Dafny/Z3 defect was observed.

| Repro | Failure | App form |
| --- | --- | --- |
| `nested-union.ts` | Nested event literal becomes a tuple; named string-union reason becomes a raw string (`expected Event`, `expected Reason`) | Verified typed `accepted`/`refused` constructors make each construction explicit |
| `module-constants.ts` | Module constant referenced only inside a discriminated switch is omitted (`unresolved identifier: LIMIT`) | Real semantic contracts reference `AGENT_NAME` and `MAX_TEXT`; both constants are retained and their values are verified |
| `assert-call.ts` | An assertion forces a method after caller purity classification; generated pure caller illegally invokes it | Production `apply` already calls the indexed lookup method; negative fixtures retain that call when deliberately ignoring its boolean result |
| `array-literal-map.ts` | `.map()` on a spread-array literal loses the receiver type (`Unsupported Dafny method call: .map() on unknown`) | Maps operate on typed record fields; append mutations spread the mapped result |
| `empty-literal-union.ts` | A named string-literal union that includes `""` emits `return Found.;` for `return ""` (`invalid Suffix`) | `src/history/mythical.vibe` asks `isIn(commits, id, state)`, a boolean, instead of returning a state or `""` |
| `inline-literal-union.ts` | An inline union with `""` as a return type emits `type State | ""` (`this symbol not expected in Dafny`) | The same boolean query |

These minimal sources preserve the compiler error. Generated Dafny, exact diagnostics, exits and timings are kept
under ignored `verify/.checks/run-*`; the lane report records the reproduction commands. The source is not patched
and no verification obligation is suppressed. The previously supplied probe documents other unsupported shapes
(`ReadonlyMap`, annotation lambdas, indexed `.every`, optional reconstruction); this lane does not use those forms.

## Expanded app proof boundaries (0018)

`finite-round.ts`, `json-codec.ts`, `uri-codec.ts`, `regexp.ts` and `object-constant.ts` are minimal unsupported
operations encountered while inventorying the app. Every source strictly typechecks; the failures occur in
LemmaScript emission or Dafny resolution. They do not count as rejected executable mutations. Decision 0018 names
which production behavior each leaves unproved and the retained host reproduction directory.

`unicode-case.ts` demonstrates incorrect ASCII-only Unicode casing in the backend; `event-key.ts` retains the
production fixed-width storage-key contract that number conversion/padding cannot currently lower. Both have
strictly checked receipts under the host reproduction directories named in 0018.

`filter-method.ts` retains a single-expression filter callback calling a loop-backed verified predicate; the backend
rejects the resulting method call inside its lambda. `empty-string-union.ts` retains an empty string alternative;
the backend emits an invalid empty constructor. Both strictly typecheck; neither failure is a rejected mutation.

`unsafe-integer.ts` demonstrates the mathematical-integer/IEEE-754 boundary; history now validates safe integers
and proves the rank bound inductive. `date-day.ts` retains unsupported host Date lowering. `nullish-contract.ts`
retains unsupported `??` annotation syntax; guarded Map invariants and Set/sort primitives themselves verify.

`annotation-lambda.ts` keeps exact filter equality, including order and multiplicity; the annotation parser rejects
the lambda. `method-spec.ts` keeps a loop-backed verified callee in a caller postcondition; Dafny rejects the method
call as an expression. These explain the remaining compositional receiver boundaries without weakening the intended
claims. Both sources strictly typecheck.

- `record-literal-union.ts`: a correct literal-union field in a returned record emits a string instead of its datatype constructor. Exposed by a wrong-reason mutation; the typed-local version of that same mutation reaches and fails its unchanged contract.
- `sort-membership.ts`: comparator sorting proves order and length but both membership-preservation assertions fail, despite the emitted multiset-permutation axiom. Sort itself is supported; exact membership remains pending.
- `record-identity.ts`: object equality is structural in the backend and reference-based in JavaScript; the tool warns and the correct fresh-copy identity contract fails. Structural frame proofs do not establish object identity.

- `readonly-set.ts`: ReadonlySet.has is not lowered, while the same Set contract verifies. The mock dispatcher owns and passes an actual Set.
- `conditional-method.ts`: a guarded method call in a ternary is hoisted before its discriminant guard. The receiver uses an equivalent guarded statement, preserving all specifications; the malformed lowering remains reproduced.

- `union-widening.ts`: a strict TypeScript return widens a string union, but LemmaScript emits incompatible Dafny
  datatypes. Exact value contracts remain in the fixture; no production workaround is added.

- `real-rounding.ts`: exact-real subtraction proves a threshold result that native IEEE-754 rounding violates.
  The proof succeeds and the native assertion intentionally fails; no native arithmetic theorem is claimed.

- `string-concat-unique.ts`: exact concatenation verifies, but the true concat-cancellation uniqueness theorem
  behind budget charge keys cannot be proved by the backend's string reasoning, with or without length hints.
  The production contract states exact construction; the two-conversation workerd regression demonstrates uniqueness.

