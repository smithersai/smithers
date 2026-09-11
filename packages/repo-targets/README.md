# Smithers repository targets

Private build defaults and AI review rules used by this repository’s `PACKAGE.ts` files. This package is not published. Applications using Smithers should declare their own targets with `@smthrs/targets`.

| Export                           | What it declares                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BuildAndCheckTypeScriptPackage` | Build ESM and CommonJS, typecheck tests, run Vitest, ESLint, dprint, a README check, and the circular dependency script; expose documentation files as a file group. Defaults use this repository’s scripts and `eslint.jsdoc.js`. |
| `ReviewTagsMigrationsAndKeys`    | Ask Codex to check module-path tags, reject compatibility aliases, require new migrations for stored schema changes, and require an explanation for changed step, cache, or run keys.                                              |
| `ReviewDocsAgainstCode`          | Ask Codex to compare changed public APIs with the package README, `docs/*.md`, and its matching site API reference pages.                                                                                                                                                      |
| `ReviewJsdocAgainstCode`         | Ask Codex to compare changed exports with their documented behavior, errors, defaults, and `@since` version.                                                                                                                       |

The review functions declare `LlmLint` targets. They run under `smthrs review`, compare against `origin/main` by default, and run on the `codex` engine with `gpt-5.6-luna`. Every macro requires `cwd`, the package directory its default globs resolve against; a workspace-wide review passes `"."` with `//`-rooted globs. Pass `engine` and `model` together to run another engine, for example `{ engine: "claude", model: "claude-opus-5" }`; `model` alone names another Codex tier. They do not modify files. The shared prompt and review helper live in `src/ReviewLint.ts` and each rubric lives in the module named after its macro; the build defaults live in `src/BuildAndCheckTypeScriptPackage.ts`.

`ReviewDocsAgainstCode({ cwd })` selects site pages at `//apps/site/src/content/docs/docs/reference/api/<package>*.mdx`, where `<package>` is the last directory in `cwd`. A workspace-root declaration selects only `README.md` and `docs/*.md` by default. Pass `context` to replace the set or opt into specific concept and guide sections. The featured root review uses package READMEs, site concepts, and selected runtime and build API references. Context expands across `PACKAGE.ts` boundaries, must match at least one file when declared, and must fit LlmLint's 512-file and 2 MiB aggregate limits. Each file is limited to 1 MiB. Regression tests check the default and root selections against the workspace files.

Root development dependencies make this package available to repository declarations. Published packages must not depend on it or re-export it.

`BuildAndCheckTypeScriptPackage` accepts `testTimeoutMs` for a package whose complete test process needs a different outer deadline. The default remains 20 minutes. This option preserves the selected suite, its per-case deadlines, and its aggregate coverage thresholds.

`BuildAndCheckTypeScriptPackage` options each feed a fixed set of targets. `sources` feeds `lib`, `check`, `test`, `lint`, `fmt`, and `circular`. `entry` feeds `lib` alone and defaults to `src/index.ts`; the built distribution's entry file and declaration take their name from it, so a package that moves its sources declares both. `tests` feeds `test` alone, so a package excluding a tier such as `test/faults/**` from its suite keeps that tier typechecked and formatted. `testSources` feeds `check` and `fmt` and defaults to `test/**/*.ts`.

`BuildAndCheckTypeScriptPackage` accepts `testData: readonly string[]` for package-relative fixture globs, for example `testData: ["test/fixtures/*.mjs", "test/fixtures/*.cjs"]`. These files join the test target inputs so fixture edits invalidate cached test results. The default is empty.

`pnpm --filter @smthrs/repo-targets test` enforces 100% V8 coverage across `src/**`. Both required CI package selections reach its declared Vitest target, `//packages/repo-targets:test`. The suite checks the actual CLI discovery result and the target's runner configuration, so a declared test script alone cannot satisfy that contract.

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
