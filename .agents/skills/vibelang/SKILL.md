---
name: vibelang
description: Write, edit or review VibeLang (.vibe files), Effect programs in TypeScript syntax. Use for any .vibe file, diff or question about VibeLang.
---

# VibeLang

VibeLang is TypeScript with syntax for Effect. An `effect` function returns an Effect, `try` runs an Effect, and every construct is exact sugar for the Effect TypeScript beside it, with Effect 4's runtime behavior. Plain and `async` functions mean what they mean in TypeScript. `vibelang` (a TypeScript 7 compiler) checks `.vibe` and `.ts` files together and emits JavaScript and declarations.

## The model

- `effect` goes exactly where `async` goes: `effect function load(id: string) { … }` declares an Effect function, as do `effect function (id) { … }`, `effect (id) => …` and a method `effect find(id) { … }` in a class or object literal. A function with no modifier is plain. Outside a class or object literal, `effect f() { … }` is an error: write `effect function f() { … }`. Calling it returns its Effect unrun, as calling an `async` function returns a Promise. Its return type is an Effect, written or inferred.
- Inside an `effect` function or an `effect { }` block, `try e` runs the Effect `e` and gives its success value; a failure propagates, as `yield*` does in Effect TypeScript. An Effect that can't fail is still run with `try`.
- `e catch h` runs `e` and, on a failure, calls the handler `h` with the error. The handler is always a function literal, and its syntax decides its kind. A plain function's result becomes the success: `fetchUser(id) catch () => guest`, `fetchUser(id) catch (e) => e._tag`. An effect function runs Effects and fails again, typed, with `throw`: `fetchUser(id) catch effect (e) => match (e) { when NotFound: guest; default: throw e; }`. A `throw` inside a plain handler is a defect, and a value, a name or an `effect { }` block after `catch` is a syntax error. Write `try x` or `x catch h`, never both. Effect code has no `try` statements, including `try`/`finally`; cleanup uses `ensuring` or `onExit`. `catch` binds like `??`, left to right; mixing it with `??`, `||` or `&&` requires parentheses.
- Calling an Effect function returns its Effect unrun, so pass that Effect as a value: `try retry(fetchUser(id), policy)`, `try timeout(retry(load(), policy), "1 second")`, or with TC39's Hack pipe, `try (load() |> retry(%, policy) |> timeout(%, "1 second"))`.
- `effect { … }` builds an Effect from statements without running it, Effect's `Effect.gen`. `do { … }` is TC39's do expression: it runs now and gives its block's normal completion value (`do { 7; {} }` is `7`).
- `async` and `await` are for Promises only. `await` in an `effect` function, and `await` of an Effect, are errors. Wrap a Promise for Effect code, `try tryPromise(() => load())`, and run an Effect from TypeScript or `async` code with `await runPromise(program)`.
- `throw new NotFound({ id })` in an `effect` function fails with that typed error, as `Effect.fail` does. In a plain function, `throw` is JavaScript's. The compiler infers and tracks what a non-Effect function may throw: Effect code calls a function that may throw only through `try Effect.try(() => parse(s))`. A plain function's `try`/`catch` is JavaScript's and catches every exception.
- `A!E!R` is exactly `Effect.Effect<A, E, R>`. An omitted slot is `never`, never inferred: `User!!` cannot fail and needs nothing. To infer a type, leave the annotation out.
- Every export of Effect's `Effect` module is a global (`retry`, `timeout`, `sleep`, `log`, `all`, `race`, `sync`, `promise`, `tryPromise`, `callback`, `scoped`, `acquireRelease`, `ensuring`, `exit`, `runPromise`, …), and every root module of `effect` is in scope (`Schema`, `Layer`, `Stream`, `Option`, `Console`, `Config`, `Duration`, `Schedule`, …), with no import. A name that clashes stays qualified: `Effect.try`, `Effect.catch`, `Effect.match`, `Effect.provide`, `Effect.uninterruptible`, `Effect.interruptible`, and `Effect.Array`, `Effect.String` and the like where JavaScript's global wins.

## Forms

| Effect TypeScript | VibeLang |
| --- | --- |
| `const load = (id) => Effect.gen(function* () { … })`, `Effect.fn` | `effect function load(id) { … }` |
| `Effect.gen(function* () { … })` | `effect { … }` |
| `yield* e` | `try e` |
| `Effect.fail(err)` | `throw err` |
| `Effect.catch(e, (err) => Effect.succeed(…))`, `Effect.orElseSucceed(e, () => v)` | `e catch (err) => …`, `e catch () => v` |
| `Effect.catch(e, (err) => Effect.gen(…))` | `e catch effect (err) => { … }` |
| `Effect.catchTag(e, "NotFound", …)` | `e catch effect (err) => match (err) { when NotFound: …; default: throw err; }` |
| `class E extends Data.TaggedError("E")<{ readonly id: string }> {}` | `error E { id: string }`, `error Timeout` |
| `class E extends Schema.TaggedError<E>()("E", { id: Schema.String }) {}` | `schema error E { id: string }` |
| `Context.Service<Users, {...}>()("app/Users")` | `service Users { find(id: string): User!NotFound }`; the key is derived, `static readonly key = "app/Users"` keeps one, and `static readonly defaultValue = () => ({ … })` makes a `Context.Reference` |
| `yield* Users`, then a member | `const users = try Users`, then `try users.find(id)`; or `try (try Users).find(id)` |
| `Layer.effect(Users, Effect.gen(…))`, `Layer.succeed(Users, impl)` | `Layer.effect(Users, effect { …; return { … } })`, `Layer.succeed(Users, impl)` |
| `Effect.provide(e, [AppLive, Layer.succeed(Users, users)])` | `provide AppLive, Users = users { try a(); try b() }`, a statement in Effect code |
| `Schema.Struct({ … })` and its type | `schema User { id: string; nick?: string; role: "admin" \| "member"; home: Address }` |
| `Schema.Literals([...])` and its type | `schema Code = "a" \| "b"` |
| `Data.TaggedEnum<{ … }>` and `Data.taggedEnum` | `data Delivery { Waiting; Sent { tracking: string } }`; `Delivery.Waiting()`, `Delivery.Sent({ tracking })`; generic `data Outcome<A, E> { Ok { value: A }; Err { error: E } }` (up to four type parameters) |
| `Match.value(x)…Match.exhaustive` | `match (x) { when "a": 1; when { _tag: "Sent", let tracking }: tracking; default: 0; }` |
| `Effect.forkChild(w)`, `forkIn(w, scope)`, `forkScoped(w)`, `forkDetach(w)` | `fork w()`, `fork.in(scope) w()`, `fork.scoped w()`, `fork.detached w()` |
| `Fiber.join(f)` | `join f` |
| `Effect.all([a, b], { concurrency: "unbounded" })` | `try.all [a(), b()]`; `try all([a(), b()])` runs them one at a time, as `Effect.all` does |
| `Effect.raceAllFirst`, `Effect.raceAll` | `try.race [a(), b()]` (first to finish), `try.any [a(), b()]` (first success) |
| `Effect.all([Effect.exit(a()), Effect.exit(b())], { concurrency: "unbounded" })` | `try.allSettled [a(), b()]`: each result is an `Exit`, including defects and interruption; the whole never fails |
| `Effect.forEach(xs, f, { concurrency: 4, discard: true })` | `for concurrent(4) (const x of xs) { try f(x) }`; `for concurrent (…)` is unbounded |
| `Stream.runForEachWhile(s, …)` | `for try (const x of s) { … }` |
| a Stream from `Stream.callback` | `effect function* ticks() { yield 1; try sleep("1 second"); yield 2 }` |
| `Effect.uninterruptibleMask((restore) => …)`, `Effect.interruptible(e)` | `uninterruptible { try a(); restore { try b() } }`, `interruptible { try poll() }` |
| `Effect.scoped(Effect.gen(…))` with `acquireRelease` | `try scoped(effect { const r = try acquireRelease(open(), (r) => close(r)); … })` |
| `Effect.ensuring`, `Effect.onExit` | `try ensuring(effect { … }, cleanup)`, `try onExit(effect { … }, (exit) => …)` |
| `Effect.exit(e)` | `match (try exit(load())) { when Exit.Success(let v): v; when Exit.Failure(let cause): …; }` |
| `Effect.sync`, `Effect.promise` | `try sync(() => count * 2)`, `try promise(() => load())` |
| `Effect.try`, `Effect.tryPromise` | `try Effect.try({ try: () => JSON.parse(s), catch: (e) => new Bad({ e }) })`, `try tryPromise({ try: (signal) => sdk.get(id, { signal }), catch: (e) => new Bad({ e }) })` |
| `Effect.withSpan(e, "load")` | `try withSpan(effect { … }, "load")` |
| `NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))` | `export effect function main() { … }`, then at the top level `NodeRuntime.runMain(Effect.provide(main(), NodeServices.layer))`, or `await runPromise(main())` |

## Rules

1. `try` runs only Effects, and only inside an `effect` function or block. A module's top level is ordinary JavaScript: top-level `await` of a Promise works there, and `try` does not.
2. Platform access goes through Effect's services, provided by a per-platform layer: `FileSystem`, `Path`, `HttpClient`, `ChildProcess`. A `.vibe` file has no `node:*` value imports and no Node globals such as `process` or `Buffer`; code that needs them lives in a `.ts` file, including platform calls inside `Effect.try` and `tryPromise` arrows. What Effect lacks lives under `Experimental`: `Experimental.Process`, `Experimental.FileSystem` and `Experimental.Crypto`, which `ExperimentalNodeServices.layer` from `vibelang-runtime/experimental/platform-node` (or Bun's) provides, and `Experimental.Locks`, which `ExperimentalBrowserServices.layer` from `vibelang-runtime/experimental/platform-browser` provides.
3. A service is a key, not a class to use: `class X extends Users` (EK3002), `new Users()` (EK3003), `x instanceof Users` (EK3004) and `service Repo<T>` (EK3005) are errors, and keys are unique (EK3001). `Users` is the type in R; `Users.Shape` is the members an implementation has.
4. An `error` is a `Data.TaggedError` class: its tag is its name and its fields are readonly. Its body may hold methods and getters, not a constructor, an `extends` clause or a `_tag` override; group errors with a union. `when NotFound:` matches by `_tag`, across copies of a package.
5. `match` is TC39 pattern matching. A `match` without `default` over a finite union that misses a case is a compile error; the check never changes what runs.
6. `using` is TypeScript's `using`. Effect resources use `scoped` and `acquireRelease`.
7. In `for concurrent`, `continue` ends one item, and `break` and `return` are errors. In `for try`, `continue` skips an element, `break` stops, and `return` is an error. A producer may `return` but not `return value`; a sequential producer can run up to two elements ahead of its consumer (one buffered, one waiting), and yields from a `for concurrent` body have no such bound.
8. `restore { }` is allowed only inside `uninterruptible { }`. In `provide`, `uninterruptible`, `restore` and `interruptible` blocks, `return`, `break` and `continue` reach the enclosing function or loop, as in ordinary TypeScript blocks.
9. `effect`, `error`, `schema`, `data`, `service`, `provide`, `uninterruptible` and `interruptible` are contextual keywords: the name or block follows on the same line, so `const error = …` and `Layer.effect` keep working. In effect code and an effect function's parameters, `fork` and `join` are reserved words, as `await` is in an `async` function, and their operand may start on the next line. Declarations export as TypeScript's do: `export effect function load`, `export error NotFound`, `export service Users`, `export schema User`, `export data Shape`.
10. The compiler writes `x.d.vibe.ts` beside each `x.vibe`, the declarations idiomatic Effect TypeScript would have, with `@throws {T}` on every non-effectful call signature it emits, `@throws {never}` included. A foreign non-Effect function without `@throws` is assumed to throw `unknown`, and a `.vibe` one's throws are inferred; Effect-returning functions never throw at the call, and their failures belong to the Effect's error channel.
11. Configuration lives in `vibe.config.json`, a superset of `tsconfig.json`, or under a top-level `"vibe"` key in `tsconfig.json` or `jsconfig.json`. It can turn the Effect globals off. `vibe.severities` maps warning codes and assigned `EK38xx` lint codes to `"error"`, `"warning"`, `"suggestion"` or `"off"`; `extends` merges by code. Invalid entries are `EK3006`; unknown or wrong-typed `vibe` options are `EK3007`. Warnings keep exit status zero; use `"error"` to fail CI. `vibelang --fix` migrates legacy `vibelang.diagnostics` (`EK3009`).
12. Tests use `@effect/vitest`: `it.effect("loads a user", () => effect { const user = try load("1"); try Effect.try(() => expect(user.name).toBe("Ada")) })`; an assertion may throw, so it runs in `Effect.try`. `it.effect` runs on a test clock, so `sleep` waits until `try TestClock.adjust("1 second")` moves time; `it.live` uses real time.

## Idioms

- Errors: an `error` per failure, `throw` to fail, `x catch () => fallback` for a default, `match` to choose: `error-management/014-expected-errors`, `error-management/016-fallback`, `error-management/017-matching`.
- Services: only `service` declarations (abstract classes are ordinary); `static readonly key = "app/Users"` overrides the derived key, and `static readonly defaultValue = () => shape` supplies a `Context.Reference` default checked as `() => Users.Shape`; `Layer.effect(S, effect { … })`, `provide` once around `main`: `requirements-management/025-services`, `requirements-management/027-layers`.
- Retries and timeouts: pass the Effect to `retry` and `timeout`, or pipe it: `error-management/018-retrying`, `error-management/019-timing-out`.
- Concurrency: `try.all` and its siblings take arrays; for an object use `try all({ user: load() }, { concurrency: "unbounded" })`; the `fork` forms and `join`, `for concurrent`: `concurrency/007-basic-concurrency`, `concurrency/047-fibers`.
- Resources: `scoped` and `acquireRelease`: `resource-management/029-introduction`.
- Data: `schema` declarations, fields of any schema (`Schema.NumberFromString`), and `Schema.Struct` for struct checks and `optionalKey`: `schema/087-basic-usage`. Tagged unions: `data`, `data-types/073-data`.
- Matching: `vibelang-features/116-match-and-is`. Producers: `vibelang-features/112-producers`. Handlers are an open proposal, not a feature: `vibelang-features/111-control-operations-and-handlers`.
- Platform services: `platform/105-introduction`; each Node.js or web global's replacement: `platform/platform-globals`.
- TypeScript at the edges: `Effect.try`, `tryPromise`, `runPromise`: `vibelang-features/114-vibelang-for-effect-users`.
- Every form beside its Effect code: `vibelang-features/115-cheat-sheet`. The language decisions: `docs/design/vips/`.

```vibe
// pending: VIP-1, VIP-2, VIP-6, VIP-26, VIP-33
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

export effect function main() {
  const name = try Config.withDefault(Config.String("NAME"), "stranger")
  const fs = try FileSystem.FileSystem
  const path = try Path.Path
  try scoped(effect {
    const directory = try fs.makeTempDirectoryScoped()
    const file = path.join(directory, "hello.txt")
    try fs.writeFileString(file, `Hello, ${name}!`)
    try Console.log(try fs.readFileString(file))
  })
}

NodeRuntime.runMain(Effect.provide(main(), NodeServices.layer))
```

`Config.String` is Effect 4's spelling, and `withDefault` handles missing input while keeping validation failures. `scoped` closes the temporary directory's scope, removing the directory and its files, when its Effect ends.
