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
