/**
 * Conventional TypeScript package target expansion.
 *
 * @since 0.1.0
 */

import { Suite } from "@smthrs/targets/Compose"
import { DocsParity } from "@smthrs/targets/DocsParity"
import { Dprint } from "@smthrs/targets/Dprint"
import { EsLint } from "@smthrs/targets/EsLint"
import { Filegroup } from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import { NodeBench } from "@smthrs/targets/NodeBench"
import { entrypoint, NodeTest } from "@smthrs/targets/NodeTest"
import type * as PackageManager from "@smthrs/targets/PackageManager"
import type * as Reference from "@smthrs/targets/Reference"
import type * as Target from "@smthrs/targets/Target"
import { TsBuild } from "@smthrs/targets/TsBuild"
import { Typecheck } from "@smthrs/targets/Typecheck"
import { Vitest } from "@smthrs/targets/Vitest"
import { VitestBench } from "@smthrs/targets/VitestBench"
import { CircularImports } from "./CircularImports.ts"
import { reachedSources } from "./WorkspaceSources.ts"

/** A host as `process.platform` names it. */
type Host = "linux" | "darwin" | "win32"

/**
 * Options accepted by {@link BuildAndCheckTypeScriptPackage}.
 *
 * `cwd` is the workspace-relative package directory every emitted target's
 * tool runs in. It is required because every default input is package-shaped,
 * so a declaration passes its own directory, for example `packages/smithers/flows/plan`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The package manager every emitted target runs its tool through. Omitted —
   * which is what a PACKAGE.ts writes — every emitted target resolves it from
   * the workspace declaration when the graph is planned. A caller passes one
   * only to run a package's tools through a second manager.
   */
  readonly packageManager?: PackageManager.PackageManager | undefined
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  /**
   * File groups whose files `lib`, `check`, `test` and `lint` read beside the
   * package's own: the sources of the other workspace packages it loads, from
   * {@link WorkspaceSources}. The compiler reads their types, the lint
   * resolves their imports, and the suite runs them. A confined run is shown
   * them and its key covers them, so an edit to one reruns those four and
   * nothing else.
   *
   * Omitted, a workspace package reads the {@link WorkspaceSources} of its
   * own `cwd`, so a confined run sees every workspace package its manifest
   * reaches; a directory that is no workspace package reads none.
   *
   * @default WorkspaceSources({ cwd }) for a workspace package, else []
   */
  readonly reads?: ReadonlyArray<Target.AnyTarget> | undefined
  readonly cwd: string
  /**
   * The package's TypeScript and VibeLang sources. It feeds every target that
   * reads them: `lib`, `check`, `test`, `lint`, and `circular`. It does
   * not name the published entry point, which is `entry`, so a package that
   * relocates its sources overrides both.
   *
   * @default src/**\/*.{ts,vibe}
   */
  readonly sources?: Input.Glob | undefined
  /**
   * The published entry file `lib` declares. `TsBuild` derives the emitted
   * `dist/<format>/<name>.js` and its declaration from this basename, so a
   * package whose entry is not `src/index.ts` names it here rather than
   * inheriting a path outside its own `sources`.
   *
   * @default src/index.ts
   */
  readonly entry?: Input.File | undefined
  /**
   * The glob Vitest collects cases from. It narrows the suite `test` runs.
   * Narrowing it to a subset of the test tree, which is how a package holds a
   * tier such as fault injection out of its default suite, must not narrow
   * what `check` typechecks, what `fmt` keys on, or the helpers `test` is
   * keyed on, so those read `testSources` instead.
   *
   * @default test/**\/*.test.{ts,vibe}
   */
  readonly tests?: Input.Glob | undefined
  /**
   * Every TypeScript and VibeLang file in the package's test tree, including
   * helpers and fixtures no suite collects. It feeds `check`, and it
   * keys `test`, so an edit to a helper a case imports re-runs the suite. A
   * package that keeps its tests outside `test/` overrides it beside `tests`.
   *
   * @default test/**\/*.{ts,vibe}
   */
  readonly testSources?: Input.Glob | undefined
  /** Package-relative globs for data read by tests, included in the test cache inputs. */
  readonly testData?: readonly string[] | undefined
  readonly tsconfig?: Input.File | undefined
  readonly testTsconfig?: Input.File | undefined
  readonly vitestConfig?: Input.File | null | undefined
  /** Optional test entrypoint for a package-owned multi-environment gate. */
  readonly testProgram?: Input.File | undefined
  /**
   * Outer deadline for the complete Vitest process. Omitted, the Vitest
   * target keeps its 20-minute default. Per-case deadlines and coverage
   * thresholds remain owned by the selected Vitest config.
   */
  readonly testTimeoutMs?: number | undefined
  /**
   * The programs the suite starts by name that its packages do not install,
   * such as `Host.bin("zig")`. Each is keyed by the bytes it runs, and a
   * confined run is shown only these beside the system's own.
   */
  readonly testTools?: ReadonlyArray<Reference.HostBin> | undefined
  /**
   * Variables the suite runs with, keyed by their values. A value may name
   * `{smthrs:cache-directory}`, the build's cache directory, which a confined
   * run may write: a tool's own content-addressed cache kept there between
   * runs, as `ZIG_GLOBAL_CACHE_DIR`.
   */
  readonly testEnv?: Readonly<Record<string, string>> | undefined
  /**
   * The suite in parts, by target name: each part is a `Vitest` target of
   * its own over its `config`, which narrows the cases it collects and the
   * sources its coverage holds to. `test` then names every part and runs
   * nothing itself, and a wildcard runs each part on its own, so a suite
   * longer than a CI job can spread over several jobs.
   */
  readonly testParts?: Readonly<Record<string, { readonly config: Input.File }>> | undefined
  /** The hosts the suite runs on (`Vitest`'s `hosts`); absent, every host. */
  readonly testHosts?: readonly [Host, ...Array<Host>] | undefined
  /** Targets only the suite waits for, such as one that fills a tool's cache before the suite starts. */
  readonly testDeps?: ReadonlyArray<Target.AnyTarget> | undefined
  /**
   * The glob Vitest collects benchmark files from.
   *
   * @default test/**\/*.bench.{ts,vibe}
   */
  readonly benches?: Input.Glob | undefined
  /** Optional Vitest configuration for the package benchmark target; defaults to `vitestConfig`. */
  readonly benchConfig?: Input.File | null | undefined
  /** Vitest environment for the package benchmark target. @default "node" */
  readonly benchEnvironment?: string | undefined
  /** Optional standalone entrypoint for packages whose benchmark runs via `NodeBench`. */
  readonly benchProgram?: Input.File | undefined
  /** Arguments forwarded to `benchProgram` when using `NodeBench`. */
  readonly benchArgs?: ReadonlyArray<string> | undefined
  /** Outer deadline for the package benchmark process. */
  readonly benchTimeoutMs?: number | undefined
  /** Host binaries declared for `VitestBench` targets. */
  readonly benchTools?: ReadonlyArray<Reference.HostBin> | undefined
  /** Explicit environment overrides for the package benchmark target. */
  readonly benchEnv?: Readonly<Record<string, string>> | undefined
  /** The hosts the benchmark target runs on; absent, every host. */
  readonly benchHosts?: readonly [Host, ...Array<Host>] | undefined
  /** Extra dependencies for the benchmark target beyond `reads`. */
  readonly benchDeps?: ReadonlyArray<Target.AnyTarget> | undefined
  /** Package-relative globs for extra data files read by benchmarks. */
  readonly benchData?: readonly string[] | undefined
  /** Whether the benchmark target caches green results under its declared inputs and `reads`. @default true */
  readonly benchCache?: boolean | undefined
  readonly eslintConfigs?: ReadonlyArray<Input.File> | undefined
  /** Explicit environment overrides for the package lint target (e.g. NODE_OPTIONS). */
  readonly lintEnv?: Readonly<Record<string, string>> | undefined
  readonly dprintConfig?: Input.File | undefined
  readonly readme?: Input.File | undefined
  /**
   * Page examples the `docs` target holds to their sources, such as a
   * quickstart's VibeLang tab: each `page` must show its `example` file
   * verbatim in a fence named for the file's extension, and `test` must import
   * the example. When any is listed, `docs` depends on `check` and `test`, so
   * the docs verb also compiles and runs every example a page shows.
   *
   * @default []
   */
  readonly examples?:
    | ReadonlyArray<{ readonly page: Input.File; readonly example: Input.File; readonly test: Input.File }>
    | undefined
  /**
   * The program that builds the package's distribution. It defaults to the
   * conventional `scripts/build.mjs`, which is what the repository's
   * per-package `build` script runs.
   */
  readonly buildProgram?: Input.File | undefined
  /**
   * Further files the build program reads, beyond `sources` and the shared
   * build scripts. `@smthrs/cli` bundles `apps/tui` into its distribution.
   *
   * @default []
   */
  readonly buildInputs?: ReadonlyArray<Input.Glob | Input.File> | undefined
  /**
   * Further files ESLint reads without linting (such as JSON files imported by
   * sources). They are declared as key material on `lint.data` and never reach
   * the ESLint argv.
   *
   * @default []
   */
  readonly lintData?: ReadonlyArray<Input.Declared> | undefined
  /**
   * The circular-dependency guard this package runs. It defaults to the
   * repository's shared guard, `//packages/repo-targets/scripts/circular.mjs`
   * (see {@link CircularImports}), which is also what every package's
   * `circular` script runs.
   */
  readonly circularScript?: Input.File | undefined
}

/**
 * The conventional targets emitted by {@link BuildAndCheckTypeScriptPackage}.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly check: ReturnType<typeof Typecheck>
  readonly test: ReturnType<typeof Vitest> | ReturnType<typeof NodeTest> | ReturnType<typeof Suite>
  /** The parts `test` runs, when the package declares `testParts`. */
  readonly testParts: Readonly<Record<string, ReturnType<typeof Vitest>>>
  /** Incremental performance benchmark target (`smthrs bench` / `smthrs affected bench`). */
  readonly bench: ReturnType<typeof VitestBench> | ReturnType<typeof NodeBench>
  readonly lint: ReturnType<typeof EsLint>
  readonly fmt: ReturnType<typeof Dprint>
  readonly docs: ReturnType<typeof DocsParity>
  readonly circular: ReturnType<typeof NodeTest>
  /**
   * The package's documentation as a file group: `docs/**\/*.md`, the README,
   * and `package.json`. It joins no verb; a generator elsewhere in the
   * workspace that reads a package's docs lists this target in its `data`,
   * which is the one way an input glob may reach across a package boundary.
   */
  readonly docsFiles: ReturnType<typeof Filegroup>
}

/**
 * The sources a package at `cwd` reads when its declaration names none: the
 * {@link WorkspaceSources} of a workspace package, and nothing for a
 * directory that is not one. Without them a confined run hides every
 * workspace package the sources import, and the lint fails on
 * `import/no-unresolved` though the unconfined run passed.
 */
const defaultReads = (cwd: string): ReadonlyArray<Target.AnyTarget> => Object.values(reachedSources({ cwd }) ?? {})

/**
 * Expands one conventional package into `lib`, `check`, `test`, `lint`,
 * `fmt`, `docs`, `circular`, and `docsFiles` targets.
 *
 * Defaults follow the Smithers repository layout: TypeScript and VibeLang
 * sources in `src`, tests in `test`, the package `build` program over the
 * package `tsconfig.json`, the test half of the package `check` script as
 * `vibelang -p tsconfig.test.json --noEmit`, Vitest with
 * the package `vitest.config.ts`, ESLint with the package flat
 * `eslint.config.js` plus the root `eslint.jsdoc.js`, and dprint with the
 * package `dprint.json`. Together `lib` + `check` cover what the repository's
 * package `check` scripts cover, and `lint` + `fmt` cover what its `lint`
 * scripts cover, and `circular` is the per-package `circular` script, so the
 * `ci` verb over these targets is gate-equivalent to the pnpm scripts. Lint covers the source glob only, matching the
 * repository's package lint scripts; the flat config declares no coverage
 * for test files, and ESLint 9 fails on a pattern whose matches are all
 * unconfigured. `check` depends on `lib` because the test tsconfig resolves
 * workspace dependencies through their built declarations. `docs` is the
 * documentation-parity target over the package README and any declared page
 * `examples`; with examples it depends on `check` and `test`. It participates in
 * the `docs` verb alone; the aggregate `ci` command plans that verb alongside
 * build, test, and lint. `docsFiles` is the package's documentation named as
 * a `Filegroup` (`docs/**\/*.md`, the README, `package.json`); it joins no
 * verb and exists so a generator in another package, such as the site's API
 * page sync, can depend on the docs by label instead of through a glob that
 * package scoping expands to nothing. Callers can override any shared input
 * without replacing the macro; each option documents which targets it feeds.
 * `sources` and `entry` are separate options, as are `tests` and
 * `testSources`, because the published entry point is one file inside the
 * sources and because narrowing the suite one package runs must not narrow
 * what it typechecks. Formatting declares the whole package for dprint config discovery.
 * The call returns declarations and runs no
 * tool; see "Failure contracts" in the package README for declaration and
 * execution failures.
 *
 * @category macros
 * @since 0.1.0
 */
export const BuildAndCheckTypeScriptPackage = (options: Options): PackageTargets => {
  const cwd = options.cwd
  const deps = options.deps ?? []
  const reads = options.reads ?? defaultReads(cwd)
  const sources = options.sources ?? Input.glob("src/**/*.{ts,vibe}")
  const tests = options.tests ?? Input.glob("test/**/*.test.{ts,vibe}")
  const testSources = options.testSources ?? Input.glob("test/**/*.{ts,vibe}")
  const entry = options.entry ?? Input.file("src/index.ts")
  const tsconfig = options.tsconfig ?? Input.file("tsconfig.json")
  const testTsconfig = options.testTsconfig ?? Input.file("tsconfig.test.json")
  const vitestConfig = options.vitestConfig === undefined
    ? Input.file("vitest.config.ts")
    : options.vitestConfig
  // Every file after the first is key material for what the flat config
  // reads: the two shared rule sets it imports. The tsconfigs its typed rules
  // load are the lint's data, so a package that names its own configs keeps them.
  const eslintConfigs = options.eslintConfigs ?? [
    Input.file("eslint.config.js"),
    Input.file("//eslint.jsdoc.js"),
    Input.file("//eslint.invariants.js")
  ]
  const dprintConfig = options.dprintConfig ?? Input.file("dprint.json")
  // The published packages are dual: `PackageJson` derives an `import` and a
  // `require` condition from this `format`, and `.smithers/flows/release/pack-release.mjs`
  // refuses a package missing either half. One `tsc -p` run emits one format,
  // so the producer is the package's own build program, which compiles the
  // ESM half and its declarations with the package tsconfig and rewrites the
  // same sources as CommonJS in a second pass.
  const lib = TsBuild({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    srcs: [
      sources,
      Input.file("//packages/repo-targets/scripts/build-library.mjs"),
      Input.file("//packages/repo-targets/scripts/private-effect-adapters.mjs"),
      Input.file("//packages/repo-targets/package.json"),
      Input.file("//packages/smithers/scripts/compile-commonjs.mjs"),
      Input.file("//packages/repo-targets/contracts/check-single-effect-version.mjs"),
      ...(options.buildInputs ?? [])
    ],
    entries: [entry],
    deps: [...deps, ...reads],
    tsconfig,
    tool: { name: "program", entry: options.buildProgram ?? Input.file("scripts/build.mjs") },
    format: "dual",
    outDir: "dist",
    cwd
  })
  // The test tsconfig extends the package tsconfig, and `Typecheck` keys only
  // the file it names, so `check` declares the base as its own input. A
  // loosened compiler option in the base then re-keys `check` directly
  // instead of relying on the `lib` dependency key to carry it. `Typecheck`
  // runs `vibelang`, which also reads the `.vibe` source of the workspace
  // packages this one imports.
  const check = Typecheck({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    srcs: [
      sources,
      testSources,
      tsconfig,
      Input.file("//packages/repo-targets/test-utils/test-schemas.ts"),
      Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"),
      Input.file("//packages/repo-targets/test-utils/effect-property.mjs"),
      Input.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
      Input.file("//packages/repo-targets/test-utils/vitest-root-temp.d.mts")
    ],
    deps: [lib, ...deps, ...reads],
    tsconfig: testTsconfig,
    buildMode: false,
    incremental: false,
    cwd
  })
  const vitestOf = (config: Input.File | null) =>
    Vitest({
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      ...(options.testTimeoutMs === undefined ? {} : { timeoutMs: options.testTimeoutMs }),
      ...(options.testTools === undefined ? {} : { tools: options.testTools }),
      ...(options.testEnv === undefined ? {} : { env: options.testEnv }),
      ...(options.testHosts === undefined ? {} : { hosts: options.testHosts }),
      tests: [tests],
      sources: [
        sources,
        testSources,
        // The suite's VibeLang plugin compiles under the test tsconfig, which
        // extends the package's: both decide what the suite's cases mean.
        tsconfig,
        testTsconfig,
        Input.file("//packages/repo-targets/test-utils/effect-property.mjs"),
        Input.file("//packages/repo-targets/test-utils/coverage-teardown.mjs"),
        Input.file("//packages/repo-targets/test-utils/test-process-environment.mjs"),
        Input.file("//packages/repo-targets/test-utils/test-schemas.ts"),
        Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"),
        Input.file("//packages/repo-targets/test-utils/vitest-root-temp.mjs"),
        Input.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
        ...(options.testData ?? []).map((pattern) => Input.glob(pattern))
      ],
      deps: [lib, ...deps, ...reads, ...(options.testDeps ?? [])],
      config,
      environment: "node",
      passWithNoTests: false,
      cwd
    })
  const testParts: Record<string, ReturnType<typeof Vitest>> = Object.fromEntries(
    Object.entries(options.testParts ?? {}).map(([name, part]) => [name, vitestOf(part.config)])
  )
  const parts = Object.values(testParts)
  const test = options.testProgram === undefined ?
    parts.length === 0 ? vitestOf(vitestConfig) : Suite({ tests: parts, exclusive: true }) :
    NodeTest({
      ...(options.packageManager === undefined ? {} : { runtime: options.packageManager.runtime }),
      runner: entrypoint(options.testProgram),
      srcs: [
        sources,
        testSources,
        tsconfig,
        testTsconfig,
        Input.file("package.json"),
        ...(vitestConfig === null ? [] : [vitestConfig]),
        Input.file("//packages/repo-targets/test-utils/effect-property.mjs"),
        Input.file("//packages/repo-targets/test-utils/coverage-teardown.mjs"),
        Input.file("//packages/repo-targets/test-utils/test-process-environment.mjs"),
        Input.file("//packages/repo-targets/test-utils/test-schemas.ts"),
        Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"),
        Input.file("//packages/repo-targets/test-utils/vitest-root-temp.mjs"),
        Input.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
        ...(options.testData ?? []).map((pattern) => Input.glob(pattern))
      ],
      deps: [lib, ...deps, ...reads],
      timeout: `${options.testTimeoutMs ?? 1_200_000}ms`,
      cwd
    })
  const benches = options.benches ?? Input.glob("test/**/*.bench.{ts,vibe}")
  const benchConfig = options.benchConfig === undefined ? vitestConfig : options.benchConfig
  const benchCache = options.benchCache ?? true
  const bench = options.benchProgram === undefined
    ? VitestBench({
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      ...(options.benchTimeoutMs === undefined ? {} : { timeoutMs: options.benchTimeoutMs }),
      ...(options.benchTools === undefined ? {} : { tools: options.benchTools }),
      ...(options.benchEnv === undefined ? {} : { env: options.benchEnv }),
      ...(options.benchHosts === undefined ? {} : { hosts: options.benchHosts }),
      benches: [benches],
      sources: [
        sources,
        testSources,
        tsconfig,
        testTsconfig,
        Input.file("package.json"),
        ...(options.benchData ?? []).map((pattern) => Input.glob(pattern))
      ],
      deps: [...reads, ...(options.benchDeps ?? [])],
      config: benchConfig,
      environment: options.benchEnvironment ?? "node",
      passWithNoTests: false,
      cache: benchCache,
      cwd
    })
    : NodeBench({
      ...(options.packageManager === undefined ? {} : { runtime: options.packageManager.runtime }),
      entry: options.benchProgram,
      ...(options.benchArgs === undefined ? {} : { args: options.benchArgs }),
      srcs: [
        sources,
        testSources,
        tsconfig,
        testTsconfig,
        Input.file("package.json"),
        ...(options.benchData ?? []).map((pattern) => Input.glob(pattern))
      ],
      deps: [...reads, ...(options.benchDeps ?? [])],
      ...(options.benchEnv === undefined ? {} : { env: options.benchEnv }),
      timeout: `${options.benchTimeoutMs ?? 600_000}ms`,
      cache: benchCache,
      cwd
    })
  const lint = EsLint({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    ...(options.lintEnv === undefined ? {} : { env: options.lintEnv }),
    sources: [sources],
    deps: [...reads],
    configs: eslintConfigs,
    // Typed rules load both tsconfigs and the test tsconfig's whole program,
    // which includes the test tree. Without them a confined run's project
    // service finds no project for any source.
    data: [testSources, tsconfig, testTsconfig, ...(options.lintData ?? [])],
    maxWarnings: 0,
    fix: false,
    cwd
  })
  const fmt = Dprint({
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    // The config chooses what dprint checks, including package docs and tooling
    // outside src/ and test/. Declare the whole package as its discovery input.
    sources: [Input.glob("**/*", { allowEmpty: true })],
    deps: [],
    config: dprintConfig,
    fix: false,
    cwd
  })
  const readme = options.readme ?? Input.file("README.md")
  const examples = options.examples ?? []
  const docs = DocsParity({
    readme,
    examples,
    deps: examples.length === 0 ? [] : [check, test],
    cwd
  })
  const docsFiles = Filegroup({
    srcs: [Input.glob("docs/**/*.md"), readme, Input.file("package.json")],
    cwd
  })
  const circular = CircularImports({
    // Omitted, the executor fills in the workspace runtime; a caller that
    // named a manager gets that manager's own interpreter.
    ...(options.packageManager === undefined ? {} : { runtime: options.packageManager.runtime }),
    ...(options.circularScript === undefined ? {} : { script: options.circularScript }),
    sources: [sources],
    cwd
  })
  return { lib, check, test, testParts, bench, lint, fmt, docs, circular, docsFiles }
}
