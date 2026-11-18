---
title: "Test units"
description: "One test file as the unit of work: how a unit is named, what it depends on, which units a change reruns, how each appears in a run record, and how coverage thresholds hold when only some files run."
---

A test target reruns whole when any of its inputs changes. For a large suite
that is the wrong unit: `//packages/smithers/build/build-cli:test` has 250 test
files and took 36.6 minutes in the rc.18 rehearsal, and one edited file reruns
all of them.

A `Vitest` target that declares `units: "file"` is read as one unit per test
file. A change reruns only the units that read a changed file.

```ts
const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/fixtures/**/*")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  units: "file"
})
```

```sh
smithers-build units //packages/greeter:test --base main
smithers-build units //packages/greeter:test --files src/Label.ts --list
smithers-build units //packages/greeter:test --all
```

This page is the design. The [CLI reference](../reference/cli.md#units) has the
command's options.

## The label

A unit's label is its target's label, `#`, and the test file's path from the
target's package directory:

```text
//packages/greeter:test#test/Label.test.ts
```

A target name cannot hold `#`, so the first `#` splits a unit label back into
the target and the file. The label is derived from the path alone: it is the
same on every machine and for every commit that has the file. A test file
outside the target's package is written from the workspace root:
`//packages/greeter:test#//shared/x.test.ts`.

The target's own label, with no `#`, names the row that merges every unit and
judges coverage. See [Coverage thresholds](#coverage-thresholds).

## What a unit depends on

A unit reads four things.

| Input           | What it holds                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| What it reaches | The test file and every file it reaches through imports and file references                                                 |
| Shared inputs   | Files every unit of the target reads: the config and what the config reaches, and every declared input no test file reaches |
| Dependencies    | The target's dependencies whose outputs the test file reads                                                                 |
| Open imports    | Imports nothing could follow. A unit with one is affected by every change                                                   |

### What it reaches

The [resolver](/pkg/build-cli/api#resolver) reads each file's syntax,
without running or type-checking it, and follows:

- `import`, `export ... from`, `require` and `import()` with a literal path,
  resolved the way TypeScript resolves them, with the `paths` of the package's
  `tsconfig.json`;
- `new URL("<literal>", import.meta.url)`, the way a module names a file
  beside itself without importing it. A test that starts `src/main.js` as a
  child process reaches it this way.

A package under `node_modules` is named, never walked: the lockfile is its
identity, and a lockfile change selects every unit.

One walk covers every test file of the target and the config, so a source file
that fifty tests reach is parsed once. Parsed files are remembered by content
digest in the cache directory.

### Shared inputs

Imports do not show every read. A test reads fixtures and documents through the
file system, and nothing in its syntax says which. So every declared input of
the target that no test file reaches is an input of every unit. Editing a
fixture reruns the whole target, as it does today.

A declared file that some test files reach is an input of those units only.

### Dependencies

A dependency of the target is an input of a unit when the test file reads the
dependency's outputs: it reaches a file in the dependency's package that the
target does not declare, such as `dist/index.js`, or it imports the
dependency's package by name. A unit that imports only source files does not
read it. Importing only the package's `package.json` does not count either:
the manifest already selects every unit.

A unit that reads a dependency reruns when `affected` says the dependency is
affected. A dependency with no cache contract is affected by every change, so
its readers run on every change until it has one.

### Open imports

A closure never guesses. `import(name)`, `require(name)`,
`new URL(name, import.meta.url)` and a reference to a directory are dynamic. A
path that names no file is unresolved. A unit with either is selected by every
change. This is the rule of the dependency closure contract of `smithers-ci`
(contract 9), which every language's strategy follows.

A unit's closure is published in that contract's shape, by
`smithers-build units <label> --list --closures`. Its `files` hold what the
test file reaches and the shared inputs, so a reader that checks only `files`
selects correctly.

## Which units a change reruns

`units` reads the change as `affected` does: `--files`, or the Git comparison
of `--base` with `--head` or the working tree. Each changed file is read in
this order.

| The changed file                                                                                     | Units selected         |
| ---------------------------------------------------------------------------------------------------- | ---------------------- |
| Selects every target for `affected`: a lockfile, `package.json`, `PACKAGE.ts`                        | Every unit             |
| Is a shared input                                                                                    | Every unit             |
| Is reached by some test files                                                                        | Those units            |
| Is a deleted test file                                                                               | None; its unit is gone |
| Reaches the target only through an affected dependency                                               | The units that read it |
| Reaches the target any other way, such as an undeclared file in its package or a deleted source file | Every unit             |
| Does not reach the target                                                                            | None                   |

A unit with an open import is selected by any change at all.

`units` differs from `affected` in two places, both about the target itself.

`affected` selects a target with no cache contract on every change, because
nothing proves what it reads. A unit's inputs are stated on this page, so that
cause does not select a unit.

`affected` selects every target when the build tool's own source changes,
because the tool that produces a result is part of the result. In a repository
that holds the build tool, a unit that reaches such a file by import is selected
by it as by any source file. A tool source no unit reads still selects them all.

An added test file is a new unit, selected by its own path. A deleted test file
has no unit. A test file that imported a deleted file can no longer resolve the
import, so it has an open import and runs.

## How a unit runs

Each selected unit is one process:

```text
pnpm exec vitest run [--config <config>] --environment <environment> <test file>
  --reporter=default --reporter=blob --outputFile=<blob>
  --coverage.thresholds=false --coverage.reporter=text-summary
  --coverage.reportsDirectory=<directory of this run>
```

`--jobs` bounds how many run at once; the default is 4. A unit passes when its
process exits zero and wrote its blob.

One process per unit is what makes a unit's result and coverage its own. It
costs Vitest's startup once per unit: 2.4 seconds for a small file on the build
server. See [Measured](#measured).

`units` does not build the target's dependencies. Build them first.

## The run record

A run prints, and with `--results-file` writes, a run record in the shape of
`smithers-ci` contract 1. Each unit that ran is one result:

```json
{
  "label": "//packages/greeter:test#test/Label.test.ts",
  "status": "ran",
  "key": "5d0c...",
  "durationMs": 2412,
  "target": "Vitest",
  "attempts": [{ "passed": true, "durationMs": 2412 }]
}
```

`status` is `ran` or `failed`. A failed result carries the last 4,000
characters of the run's output in `error`. A unit the change does not select has
no row, as an unaffected target has none in an `affected` run. `units` counts
every unit the target has.

## Coverage thresholds

A threshold is set for the whole target, and one test file cannot meet it. Two
things keep it true when only some files run.

- **A unit's coverage is one of its outputs.** The blob a unit writes holds its
  results and its coverage. It is kept in the cache directory under the unit's
  key, so a unit that did not run still has the coverage of its last run with
  the same inputs.
- **The target's own row judges.** When every unit has a blob for its current
  key, `vitest run --merge-reports=<blobs>` merges them and applies the
  thresholds from the config. That row has the target's label and is `ran` or
  `failed`. Every run first removes the blobs no current key names, so a
  deleted or edited test leaves no coverage behind and the store holds one
  blob per unit.

When some unit has no blob for its inputs, the record says so in `coverage`,
with the count, and no row claims the thresholds passed. `--all` runs every
unit once and fills the store.

This is Vitest's own method for a suite split across machines, with each test
file as one part.

## Keys

A unit's `key` is the digest of its label, the target's run settings, the
files it reaches with their digests, the packages it imports by name, its open
imports, the shared inputs, and the dependencies it reads. Editing a file
changes the keys of the units that read it and no other.

The key does not cover the executed toolchain or a dependency's key. On its own
it does not make a result safe to cache, and `units` reads no result from a
cache: it decides by the change. Whether a unit's result may be cached is
decided with the [cache contract](../workspace/caching.md).

## Prior art

| Source                                                                                                                                                                                | What it does                                                                                                                                                                                                                                   | What this design keeps                                                                                                        | Where it differs                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`vitest related`](https://vitest.dev/guide/cli.html#vitest-related) and [`--changed`](https://vitest.dev/guide/cli.html#changed)                                                     | Takes changed files, from arguments or Git, and runs the test files whose module graph holds one. A file matching [`forceRerunTriggers`](https://vitest.dev/config/forcereruntriggers.html) runs the whole suite. No related file runs nothing | The rule itself: a test file runs when the change is in its import graph; some files rerun everything; no change runs nothing | Vitest's docs say it "works with static imports" and "not the dynamic ones", so a dynamic import is missed. Here it selects the unit on every change. Whole-suite files come from the target's declared inputs, not a second list of globs                                                                                                               |
| Vitest's module graph (`filterTestsBySource` and `getAffectedModules` in `vitest/node`)                                                                                               | Transforms each module with Vite to learn its imports, builds the reverse edges, and walks back from the changed files                                                                                                                         | Edges from imports only; installed packages are not walked                                                                    | Reads syntax and never starts Vite, so it works before Vitest runs and costs a parse, not a transform. It does not see an alias or a plugin declared only in the Vite config: such an import is unresolved and its unit always runs. It walks forward from each test file, which gives every unit a closure and a key, not only an answer for one change |
| [`jest --findRelatedTests`](https://jestjs.io/docs/cli#--findrelatedtests-spaceseparatedlistofsourcefiles), `--onlyChanged`, `--changedSince`                                         | `jest-haste-map` records each file's imports; `DependencyResolver.resolveInverse` in `jest-resolve-dependencies` walks from the changed files back to test files                                                                               | The same selection by import graph                                                                                            | Jest extracts imports by pattern and follows only what it finds. An import it cannot follow is dropped there and fails closed here                                                                                                                                                                                                                       |
| Vite's [`new URL(url, import.meta.url)`](https://vite.dev/guide/assets.html#new-url-url-import-meta-url)                                                                              | Treats the literal form as a static reference to a file                                                                                                                                                                                        | The same literal form is a followed edge                                                                                      | `vitest related` does not follow it. Here a computed form is dynamic                                                                                                                                                                                                                                                                                     |
| Vitest [sharding](https://vitest.dev/guide/improving-performance.html#sharding) with the [blob reporter](https://vitest.dev/guide/reporters.html#blob-reporter) and `--merge-reports` | Each part writes a blob of results and coverage; a last step merges them and reports                                                                                                                                                           | Exactly this, for coverage                                                                                                    | A part is one test file, and its blob is kept by key between runs                                                                                                                                                                                                                                                                                        |
| Bazel test targets                                                                                                                                                                    | Each test is a target with declared `data`; coverage is merged from each test's output                                                                                                                                                         | A unit has stated inputs, a key, and coverage as an output                                                                    | Units are found from the target's globs at run time, not declared one by one                                                                                                                                                                                                                                                                             |
| Coverage with `vitest --changed` and `jest --changedSince`                                                                                                                            | The report holds only the changed files                                                                                                                                                                                                        | Nothing                                                                                                                       | Thresholds stay whole-target and are judged from every unit's stored coverage                                                                                                                                                                                                                                                                            |

## Limits

- **A read by a computed path is not seen.** `process.cwd()`,
  `import.meta.dirname` and `fileURLToPath(import.meta.url)` followed by a join
  can read any file. If that file is a declared input no test imports, it is
  shared and the unit reruns. If another test imports it, the unit that reads
  it by path does not rerun. Name the file or its directory with
  `new URL("<path>", import.meta.url)` and the unit sees it: a file is
  followed, a directory makes the unit run on every change.
- **A dependency read by a computed path is not seen** either. A unit reads a
  dependency through an import.
- **Aliases and plugins of the Vite config are not read.** An import only they
  resolve is unresolved, and its unit always runs. That is slow, not wrong.
- **A deleted source file selects every unit.** Nothing in the current tree
  says who read it.
- **One process per unit.** A full run costs more than one `vitest run` over
  the target. See [Measured](#measured).
- **A blob holds the coverage of every included source file.** For the build
  CLI that is 5 MB per unit.
- **`units` is its own command.** `test`, `ci` and `affected` still run the
  target whole. Putting units in their plans is the next step.

## Measured

`//packages/smithers/build/build-cli:test` on the build server, 2026-11-18. The
server has 48 cores and was shared with other work, at a load average of 25 to
110, so the times moved with the load. The target has 252 test files; 239 have
a closure with no open import. Listing the units takes 30 seconds, the time any
command spends loading this workspace's declarations.

| File edited                                               | Test files run | Test files in the target |     Time |
| --------------------------------------------------------- | -------------: | -----------------------: | -------: |
| `test/Label.test.ts`, a test file                         |             15 |                      252 |  2.4 min |
| `src/FetchExec.ts`, a source file three test files import |             17 |                      252 |  2.9 min |
| `packages/ci/README.md`, a file outside the target        |             14 |                      252 |  6.7 min |
| Every unit, `--all`, four at once                         |            250 |                      250 | 58.3 min |
| The whole target in one `vitest run`                      |            252 |                      252 | 52.2 min |

Time is the wall time of the command. The first two rows are real edits, a
comment added to the file. The third names the file with `--files`. The `--all`
row was measured before two test files were added.

Fourteen test files run on every change. Thirteen have an open import: a
directory named with `new URL`, a computed `import()`, or a file that is missing
on purpose. One reads the output of `:lib`, which has no cache contract.

A file more tests import selects more units:

| File edited                                     | Test files selected |
| ----------------------------------------------- | ------------------: |
| `test/helpers/Executable.ts`                    |                  35 |
| `src/internal/Shards.ts`                        |                  77 |
| `src/Label.ts`                                  |                 142 |
| `docs/cli.md`, a declared input no test imports |                 252 |

Running every unit as its own process took 231 minutes of run time between the
units. The whole target took about 104 between its two workers. Each process
transforms its imports again, which is the difference. A change that selects a
few units is much faster as units; one that selects every unit is not.

## Next

- [Inputs](inputs.md)
- [Caching](../workspace/caching.md)
- [CLI reference](../reference/cli.md#units)
