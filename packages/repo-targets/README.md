# Smithers repository targets

Private build defaults and AI review rules used by this repository’s `PACKAGE.ts` files. This package is not published. Applications using Smithers should declare their own targets with `@smthrs/targets`.

| Export                           | What it declares                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BuildAndCheckTypeScriptPackage` | Build ESM and CommonJS, typecheck tests, run Vitest, ESLint, dprint, a README check, and the circular dependency script; expose documentation files as a file group. Defaults use this repository’s scripts and `eslint.jsdoc.js`. |
| `CircularImports`                | Fail on a cycle of run-time imports among the package's own `.ts` and `.vibe` modules. See [Circular imports](#circular-imports).                                                                                                   |
| `ReviewTagsMigrationsAndKeys`    | Ask Codex to check module-path tags, reject compatibility aliases, require new migrations for stored schema changes, and require an explanation for changed step, cache, or run keys.                                              |
| `ReviewDocsAgainstCode`          | Ask Codex to compare changed public APIs with the package README, `docs/*.md`, and its matching site API reference page.                                                                                                                                                      |
| `ReviewJsdocAgainstCode`         | Ask Codex to compare changed exports with their documented behavior, errors, defaults, and `@since` version.                                                                                                                       |
| `ImportRules`                    | Check the package's sources against declared import and call rules, each with a `because`, without a model. See [Import rules](#import-rules).                                                                                     |
| `JevRules`                       | Ask Jev one yes-or-no question per judgment rule about each covered file. See [Jev rules](#jev-rules).                                                                                                                            |
| `SdkRules`                       | Declare Will's SDK-wide rules for one SDK package: its `importRules` and `jevRules`, from one shared definition. See [SDK rules](#sdk-rules).                                                                                     |

The review functions declare `LlmLint` targets. They run under `smthrs review`, compare against `origin/main` by default, and run on the `codex` engine with `gpt-6-luna`. Every macro requires `cwd`, the package directory its default globs resolve against; a workspace-wide review passes `"."` with `//`-rooted globs. Pass `engine` and `model` together to run another engine, for example `{ engine: "claude", model: "claude-opus-5" }`; `model` alone names another Codex tier. They do not modify files. The shared prompt and review helper live in `src/ReviewLint.ts` and each rubric lives in the module named after its macro; the build defaults live in `src/BuildAndCheckTypeScriptPackage.ts`.

`ReviewDocsAgainstCode({ cwd })` selects the package's `README.md`, `docs/*.md`, and `docs/reference/*.md`. Those are the sources `apps/site` builds the package's API reference page from, so the default declares no input in another package and `//:targetIndex` sees no package crossing. Pass `context` to replace the set or opt into specific concept and guide sections. The featured root review uses package READMEs, site concepts, and selected runtime and build API references. Context expands across `PACKAGE.ts` boundaries, must match at least one file when declared, and must fit LlmLint's 512-file and 2 MiB aggregate limits. Each file is limited to 1 MiB. Regression tests check the default and root selections against the workspace files.

Root development dependencies make this package available to repository declarations. Published packages must not depend on it or re-export it.

`BuildAndCheckTypeScriptPackage` accepts `testTimeoutMs` for a package whose complete test process needs a different outer deadline. The default remains 20 minutes. This option preserves the selected suite, its per-case deadlines, and its aggregate coverage thresholds.

`BuildAndCheckTypeScriptPackage` options each feed a fixed set of targets. `sources` feeds `lib`, `check`, `test`, `lint`, `fmt`, and `circular`. `entry` feeds `lib` alone and defaults to `src/index.ts`; the built distribution's entry file and declaration take their name from it, so a package that moves its sources declares both. `tests` selects the suite `test` runs, so a package excluding a tier such as `test/faults/**` from its suite keeps that tier typechecked and formatted. `testSources` feeds `check` and `fmt`, keys `test` so an edit to a test helper re-runs the suite, and defaults to `test/**/*.{ts,vibe}`.

The default globs name VibeLang `.vibe` files beside `.ts` ones, `src/**/*.{ts,vibe}`, `test/**/*.test.{ts,vibe}`, and `test/**/*.{ts,vibe}`, so every target reads a package's `.vibe` modules and `test` is keyed on them. `check` runs `vibelang`, which checks TypeScript and VibeLang together. The package's `vitest.config.ts` runs the `vibelang-vite` plugin, which compiles the `.vibe` files the suite loads.

`BuildAndCheckTypeScriptPackage` accepts `testData: readonly string[]` for package-relative fixture globs, for example `testData: ["test/fixtures/*.mjs", "test/fixtures/*.cjs"]`. These files join the test target inputs so fixture edits invalidate cached test results. The default is empty.

`pnpm --filter @smthrs/repo-targets test` enforces 100% V8 coverage across `src/**`. Both required CI package selections reach its declared Vitest target, `//packages/repo-targets:test`. The suite checks the actual CLI discovery result and the target's runner configuration, so a declared test script alone cannot satisfy that contract.

The repository contracts also check runtime dependency declarations, both lockfiles,
reviewed public export additions and the test-pin register. Decision-queue source
snapshots are displayed data; their imports do not become maintainer-site runtime
dependencies. The private repository-view and terminal-frame packages retain their
Bun coverage gates and source exports. Published workspace references resolve to
their sibling's exact version before release packing stages a package outside the
workspace.

Presentation installation runs in freezable V8 realms with the real guarded React
renderer. Subprocess coverage maps the emitted realm modules back to their source;
installation, renderer refusals and reload deadlines remain subject to the 100% gate.

## Circular imports

`CircularImports({ cwd, sources })` declares the `test`-kind `NodeTest` target that `BuildAndCheckTypeScriptPackage` emits as `circular`; a package that declares its targets by hand calls it directly. Every package runs the one guard, `scripts/circular.mjs` in this package, and its `circular` package script runs the same file, for example `node ../repo-targets/scripts/circular.mjs` from `packages/errors`.

The guard reads the module graph the VibeLang compiler resolves for the package's `tsconfig.json`: `projectImports` from `vibelang/project` lists the program and every import its files write, each with the file it resolved to, without type-checking. `.vibe` modules, and `.ts` modules that import them, are therefore in the graph, with the compiler's own resolution of `.vibe` specifiers and package exports. An import is an edge when it loads at run time, which `src/ImportAnalysis.ts` decides from the importing file's syntax: `import type`, `export type`, `import()` types and imports whose every reference is type-only are not edges. Files under `node_modules` and in nested packages are not nodes, so a cycle is one package's own. madge, which every package declares, finds the cycles. The target keys on `sources`, `tsconfig.json`, and the guard's modules.

On a cycle the guard prints one line per cycle and exits 1:

```text
Circular dependencies found: 1
  src/SmithersError.vibe > src/ErrorCode.ts > src/SmithersError.vibe
```

It exits 2 with the compiler's diagnostics when the compiler cannot read the project, such as for an unknown compiler option.

## Import rules

`ImportRules({ cwd, rules })` declares one `test`-kind `NodeTest` target that fails when a source in the package at `cwd` breaks a rule. A package declares it in its own `PACKAGE.ts`:

```ts
import type { ImportRule } from "@smthrs/repo-targets"
import { ImportRules } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const importRules: ReadonlyArray<ImportRule> = [
  {
    kind: "forbid",
    files: ["src/**/*.tsx"],
    modules: ["effect", "effect/**"],
    because: "Components render; the state machine runs Effect. See \"State (flux)\" in apps/mvp/AGENTS.md."
  }
]

export const Package = Smithers.Package({ targets: { importRules: ImportRules({ cwd: "apps/mvp", rules: importRules }) } })
```

Run it with `pnpm exec smithers-build test '//apps/mvp:importRules'`; `ci` plans it too. It is not cached.

`forbidHostModules` uses the AST import analysis and Node’s builtin registry, including bare names such as `stream/web`, plus every `node:` and `bun:` specifier and `bun`. `SdkRules` applies it to library and app-library sources; host and component roles are exempt. See [host boundaries](docs/host-boundaries.md).

Every rule takes:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"forbid"`, `"forbidNames"`, `"rootImportsOnly"`, `"forbidCalls"` or `"forbidHostModules"` | What the rule checks. |
| `because` | `string`, required | Why, naming the `AGENTS.md` rule that governs it. Every violation prints it. |
| `files` | `ReadonlyArray<string>`, optional | Package-relative globs of the sources the rule reads, matched with `node:path` `matchesGlob`: `*` stops at `/`, `**` crosses it. Default: every source. Each rule must cover at least one source. |
| `allowTypeOnly` | `boolean`, optional, not on `forbidCalls` | Let through a reference that loads nothing at runtime: `import type`, `export type`, a `type` modifier on a named element, or an `import()` type. Default `false`: type-only imports count. `import { type A } from "x"` still counts as importing `x`, because `verbatimModuleSyntax` keeps it. |

| Kind | Field | Fails on |
| --- | --- | --- |
| `forbid` | `modules`: specifier globs (`effect` is the root, `effect/*` one level, `effect/**` every subpath) | A static import, a re-export, `import x = require()`, `import()`, `require()` or an `import()` type of a matching module. |
| `forbidHostModules` | none | A parsed import of a Node builtin or a Node/Bun module scheme. |
| `forbidNames` | `modules`, and `names`: exported names matched exactly | A named import or re-export of a name, a default import (`default`), or a member read through a namespace or default binding, such as `React.useState`. |
| `rootImportsOnly` | `packages`: package-name globs, such as `@smthrs/*` | A specifier naming a subpath of a matching package, such as `@smthrs/model/ModelError`. |
| `forbidCalls` | `callees`: callee texts matched exactly, such as `Model.stream`, or `*.<member>`, such as `*.route` | A call whose callee reads as an exact entry, or ends in an entry's `<member>` whatever the receiver. See [Callees](#callees). |

### Callees

A `forbidCalls` rule reads each call's callee as text, with parentheses, `as`, `satisfies`, `!` and `?.` removed. A string key reads as a member, a receiver that is a call ends in `()`, and any other receiver, such as an `await` or a computed key, reads as `(…)`:

| Source | Callee | `page.route` | `*.route` |
| --- | --- | --- | --- |
| `page.route(url, handler)` | `page.route` | fails | fails |
| `page?.route(url, handler)`, `page["route"](url, handler)` | `page.route` | fails | fails |
| `tab.page.route(url, handler)` | `tab.page.route` | passes | fails |
| `page.context().route(url, handler)` | `page.context().route` | passes | fails |
| `(await browser.newContext()).route(url, handler)` | `(…).route` | passes | fails |
| `router.routes()`, `reroute()`, `route()` | `router.routes`, `reroute`, `route` | passes | passes |

An exact entry matches only its own text, so `page.route` misses `tab.page.route`. Use `*.<member>` when a member name belongs to one API, as Playwright's `route` does; a `*` anywhere else is refused. Both forms are syntactic: neither sees a callee reached through destructuring, as in `const { route } = page; route(url, handler)`, and an exact entry does not see `const model = yield* Model.Model; model.stream(request)`, an alias or a parameter.

A source is a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` or VibeLang `.vibe` file under `cwd`, outside `node_modules`, `dist`, `coverage`, `target`, `tmp`, `test-results`, `playwright-report`, any dot-directory, and any nested directory with its own `package.json`. Before parsing, the check refuses every rule covering no source, reporting its zero-based index, kind, patterns and reason. An omitted `files` is reported as `["**/*"]`. There is no empty-scope exception.

Each source is parsed once with the TypeScript compiler API, in `src/ImportAnalysis.ts`, which the repository's dependency-boundary gate and circular-import guard share. A string or comment that mentions an import is not one. **Known VibeLang blocker:** `.vibe` still goes through TypeScript error recovery, which can miss VibeLang syntax. It must use compiler output before migrations can rely on it. The installed `vibelang@0.0.8` project API emits JavaScript, erasing type-only imports that these rules forbid by default; it exposes no TypeScript emit preserving those references. The [work note](../../apps/mvp/docs/work/importrules-vibelang-emit.md) records the upstream gap and reproduction.

The target runs `scripts/import-rules.mjs <cwd> '<rules JSON>'` in `cwd`. On a violation it prints one line per violation to stderr and exits 1:

```text
ImportRules failed in apps/mvp: 1 violation of 5 rules over 69 source files.

- apps/mvp/src/AppContext.tsx:1 imports "effect" (forbid). A component renders state and dispatches actions; ...
```

With none it prints `ImportRules passed in <cwd>: <n> rules over <n> source files.` and exits 0. Invalid rules and empty rule scopes exit 2.

Rules that hold for every package, such as the ban on substitute durable runtimes, belong to the repository-wide dependency-boundary gate (`contracts/check-dependency-boundaries.mjs`), not to an `ImportRules` default: that gate also covers packages with no `PACKAGE.ts`.

## Jev rules

`JevRules({ cwd, rules })` declares one `JevLint` target (from `@smthrs/targets`) for the rules no parser can check, such as "no hand-rolled retries". Each rule names its `id` from the package's rules catalog, the `files` it covers (package-relative globs, or `//`-rooted ones; `//:targetIndex` refuses a glob whose files all belong to another package), `lookFor` (a question about one file, phrased so that yes means the file breaks the rule), `violation` and `compliant` (what yes and no mean), and an optional `severity`, `error` by default:

```ts
import { JevRules } from "@smthrs/repo-targets"

const jevRules = JevRules({
  cwd: "apps/mvp",
  threshold: 0.7,
  rules: [{
    id: "durable.no-hand-rolled-durability",
    files: ["worker/!(*.test).ts"],
    lookFor: "Does this file implement its own retry loop, sweep or background job?",
    violation: "The file hand-rolls durability the flow engine owns.",
    compliant: "The file has no retry loop, sweep or background job of its own."
  }]
})
```

The macro anchors each glob at `cwd` and passes `threshold` (JevLint's default is 0.8), `failOn`, `summary` and `featured` through. The target joins `lint` but is manual, so `//...` never plans it; name its label, with `AI_GATEWAY_API_KEY` set: `smithers-build lint '//apps/mvp:jevRules'`. The executor must provide `JevReviewLive` from `@smthrs/targets/JevLint`. `apps/mvp/PACKAGE.ts` declares the app's rules and each SDK package declares the SDK-wide ones through [`SdkRules`](#sdk-rules); `apps/mvp/docs/rules.md` is their catalog.

## SDK rules

`SdkRules({ cwd, role, tests?, knownDeepImports? })` declares Will's SDK-wide rules for the package at `cwd` and returns two targets: `importRules`, an `ImportRules` target, and `jevRules`, a `JevRules` target with a threshold of 0.7. The rule text lives once, in `src/SdkRules.ts`; every SDK package lists both targets in its own `PACKAGE.ts`, so every glob stays inside that package:

```ts
import { SdkRules } from "@smthrs/repo-targets"

const { importRules, jevRules } = SdkRules({ cwd: "packages/effect-electric", role: "library" })
```

`role` decides which rules hold:

| Role          | For                                                                                       | Rules it drops                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `library`     | A platform-neutral, Effect-first library meant for any app                                | none                                                                             |
| `app-library` | A platform-neutral library that holds the Smithers app's contracts, such as `@smthrs/rpc` | `sdk.generic-libraries`                                                          |
| `host`        | A `@smthrs/platform-*` package                                                            | `sdk.platform-neutral`                                                           |
| `components`  | `@smthrs/ui`, which renders React                                                         | everything but `sdk.root-imports-only`, `sdk.no-dead-code` and `test.behavioral` |

`importRules` forbids host modules in `src/` (`sdk.platform-neutral`), a deep import of a Smithers package in `src/` or `examples/` (`sdk.root-imports-only`), and running an Effect in `src/` (`effect.boundary-only`). `jevRules` asks the judgment half of those rules, plus `effect.wrap-every-library`, `sdk.generic-libraries`, `obs.content-free`, `sdk.no-dead-code` (advisory) and `test.behavioral`, about the `.ts`, `.tsx` and `.vibe` modules in `src/` and the package's tests (`test/**/*.test.ts` and `test/**/*.test.vibe`, or `tests`). `knownDeepImports: { packages, because }` names the `@smthrs/*` packages whose subpaths a package still imports, and why; the `because` joins the rule's message. `@smthrs/model-host` (the CLI's command catalog) and `@smthrs/rpc` (its runtime-free canonical imports) declare one.

## Failure contracts

Every macro returns its target declarations synchronously. Calling one never runs a review, a build, or a tool; the executor runs the emitted targets later, when a verb such as `smthrs review` or `ci` plans them.

Declaration-time rejections happen while `PACKAGE.ts` loads:

- TypeScript rejects a call without `cwd`, and a review whose `engine` is not `codex` but names no `model`.
- `ImportRules` throws a `TypeError` naming the rule for an empty rule list, an unknown `kind` or key, a missing or blank `because`, an empty list, a `files` glob that is absolute or leaves the package, or a non-boolean `allowTypeOnly`; and for a `cwd` that is empty, absolute or leaves the workspace.
- `SdkRules` throws a `TypeError` for a `knownDeepImports` with no package, a name outside `@smthrs/`, or a blank `because`, and for any `cwd` `ImportRules` or `JevRules` refuses.
- `JevRules` throws a `TypeError` for a `cwd` that is empty, absolute or leaves the workspace. `JevLint` then refuses an empty rule list, a repeated or malformed rule id, a blank question or criterion, and a threshold outside 0.5 to 0.99.
- The emitted target's constructor validates its attributes and throws an `Error` reading `<target> declaration at <site> is invalid: <reason>`. Examples: an empty review `model`, an `engine` outside LlmLint's engine set, or a non-integer `testTimeoutMs`.

Execution failures belong to the emitted targets. The [`@smthrs/targets` error table](../smithers/build/targets/docs/reference/targets.md#errors) documents each one:

- Review targets fail with `smithers-build/ModelCliMissing` when the engine CLI, `codex` by default, is not on the host. It names the `engine` and the `executable`.
- Review targets fail with `smithers-build/LlmReviewError` when a round fails in the `diff`, `read`, `review`, or `parse` phase.
- Review targets fail with `smithers-build/FindingsError` when a finding meets the threshold: `error` for `ReviewTagsMigrationsAndKeys`, `warning` for `ReviewDocsAgainstCode` and `ReviewJsdocAgainstCode`. The error carries every finding.
- `BuildAndCheckTypeScriptPackage` targets fail with `smithers-build/ExecError` when a tool such as `tsc`, Vitest, ESLint, dprint, or the circular-import guard fails, and its `docs` target fails with `smithers-build/DocsParityError`.
- `ImportRules` targets fail with `smithers-build/ExecError` when a source breaks a rule (exit 1) or the program refuses its arguments (exit 2).
- `JevRules` targets fail with `smithers-build/FindingsError` when a finding meets `failOn`, and with `smithers-build/LlmReviewError` when `AI_GATEWAY_API_KEY` is missing, a rule matches no file, a file cannot be read, or Jev fails or leaves a question unanswered.

## Bun tests in this repository

Packages that must NOT declare this, and why:

- `database`, `engine-store`, `flows`, `journal`, `kernel`, `plan`,
  `run-store`, `step-cache`, `sync`, `time-travel`, and `examples`: Bun's
  `node:sqlite` binds the host SQLite, built with
  `SQLITE_OMIT_LOAD_EXTENSION`, which the sqlite layer requires. This
  exclusion is a contract, not a limitation: rc.0 does not run the durable
  engine under Bun, and `NodeDatabase.layer` refuses to open a database
  when `process.versions.bun` is set (`unsupported_runtime`, exclusion
  X-18). A Bun target for any of those suites would assert the refusal,
  not durable execution.
- `jj`: `NodeJjClassification` expects spawn failures to classify as
  `unknown`; Bun's `child_process` error shape classifies as
  `not_installed`.
- `platform-node`: the Node host contract suite asserts Node-host behavior
  and is not expected to pass on Bun.
