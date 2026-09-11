/**
 * Targets for the private Smithers component kit.
 *
 * The product UI (`apps/app`) imports `@smthrs/ui`, which ships its sources
 * directly and uses Bun for its tests.
 *
 * Its presence here is what this file is for. The root `packageDefaults`
 * synthesizes `BuildAndCheckTypeScriptPackage` — a dual `dist/esm` and `dist/cjs` library
 * build, a vitest
 * suite at 100% coverage, eslint, and dprint — for every `packages/*`
 * directory that ships no `PACKAGE.ts` of its own. This package satisfies none of
 * that: it ships its sources directly, types against `@types/bun`, and tests
 * with `bun test`. Declaring the targets it can honor opts it out of the
 * synthesis (`PackageDefaults` skips a directory holding a `PACKAGE.ts`) and puts
 * its real gates in the graph instead of targets that cannot pass.
 *
 * Two of the four standard gates are honored here: the `bun test` suite and a
 * `tsc --noEmit` typecheck over `src/`. The eslint and dprint halves are NOT
 * declared, because this package carries neither an `eslint.config.js` nor a
 * `dprint.json` and both tools are per-package devDependencies elsewhere in the
 * workspace; wiring them requires package tooling that this target does not
 * provide.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui"

/** The component sources the suite drives. */
const sources = [
  Smithers.glob("//packages/smithers/ui/src/**/*.ts"),
  Smithers.glob("//packages/smithers/ui/src/**/*.tsx")
]

/**
 * Checks every component source against the package tsconfig.
 *
 * The package publishes its `src/` tree directly (`files: ["src/"]`, every
 * export condition points at a `.ts`/`.tsx` source), so this typecheck is the
 * only thing standing between a type error and a consumer's build. Root
 * `pnpm run check` reaches it through the package's own `check` script.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The component suite: everything under `tests/`, run by Bun against a
 * happy-dom registrator, which is how this package has always tested.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    ...sources,
    Smithers.glob("//packages/smithers/ui/tests/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/tests/**/*.tsx")
  ],
  deps: [],
  cwd
})

/**
 * The package's documentation as a file group (`docs/**`, the README, and
 * package.json), matching the filegroup BuildAndCheckTypeScriptPackage emits. The docs-site
 * content sync in `apps/docs/ui/PACKAGE.ts` depends on it by label, the one
 * way an input reaches across a package boundary.
 */
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.glob("docs/**/*.md"), Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

/** Complete React source input for the reproducible Solid projection. */
const solidCodegenInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*"), Smithers.file("package.json")],
  cwd
})

export const Package = Smithers.Package({
  targets: { solidCodegenInputs, check, docsFiles, unitTests }
})
