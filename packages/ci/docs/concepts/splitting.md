---
title: "Splitting a step"
description: "How smithers-ci turns one CI step that runs a task over a whole workspace into one step per package, what each of those steps reads, and which steps it never splits."
---

A CI step such as `turbo run test` reads every package, so a change to any of
them reruns it. Smithers CI splits such a step into one step per package, and
names the files each one reads. A change then reruns only the steps that read a file
it touched.

```text
pnpm -r run test                    pnpm --filter=ui run test            reads packages/ui
(reads everything)        ──>       pnpm --filter=ui --filter=web run test   reads packages/ui, packages/web
                                    pnpm --filter=docs run test          reads packages/docs
```

A split is only made when it can be shown to do what the step did. A wrong
split would report a pass for code that was never run, so every doubt leaves
the step whole.

## What is split

| The step runs                                                          | It becomes                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `turbo run <task>` or `turbo <task>`, with or without `--filter`       | One `turbo run <task> --filter=<package>` per package with work          |
| `pnpm -r run <script>`, `pnpm --filter <selector> run <script>`        | One `pnpm --filter=<package>… run <script>` per package                  |
| `bun run --filter <pattern> <script>`, `bun run --workspaces`          | One `bun run --filter <package>… <script>` per package                   |
| `npm run <script> --workspaces`, `--workspace <name>`                  | One `npm run <script> --workspace=<package>…` per package                |
| A root script that is one of the commands above, as `pnpm test`        | The same, from the root script's own command and the words the step adds |
| One package's script, as `bun run --cwd packages/core test`            | The same command, with its inputs named                                  |
| A command that starts `zig`                                            | The same command, told to keep Zig's cache between runs                  |
| `zig build <step>` alone, where the build step only groups named steps | One `zig build <name>` per named step, with the step's report flags      |
| `npm run <script>`, where the script is `npm run a && npm run b`       | One step per script the chain runs, in order                             |

The packages come from the workspace the package manager reads:
`pnpm-workspace.yaml`, or `workspaces` in the root `package.json` for npm, Yarn
and Bun. A package without the script gets no step. A directory with a
`package.json` that no workspace pattern matches is not a package; every step
reads it.

Each new step keeps the original step's directory, environment and secrets, and
records the step it came from. The replay compares the original step's verdict
with the verdicts of its package steps taken together: failed if any failed.

## What a package step reads

A package step's inputs are paths and globs from the repository root:

1. **Every file outside all packages.** The lockfile, root configuration, the
   task runner's configuration, root scripts, and any directory that is not a
   workspace package. A change there reruns every package step.
2. **The package's own directory.**
3. **Every package it reaches**, to a fixed point:
   - packages it declares in `dependencies`, `devDependencies`,
     `peerDependencies` or `optionalDependencies`;
   - packages its files name: `@acme/ui` anywhere, an unscoped name such as
     `ui` only in quotes, after `node_modules/`, or in a `package.json` script;
   - paths its files write that lead into another package: `../ui/src/a.ts`,
     or `packages/ui/src/a.ts` from the root. A path that names a file adds
     that file and what the file itself names. Any other path into a package
     adds the whole package. A symbolic link counts as the path it points to.
     A relative path is read from the file it is written in; when it names
     nothing there, it is also read from the package's directory, where a
     program runs.
4. **What Turborepo's configuration declares:** `globalDependencies`, and task
   `inputs` that start with `$TURBO_ROOT$` or leave the package.

An alias is a definition, not a read. `"paths": { "@acme/ui": ["../ui/src"] }`
in a `tsconfig.json`, or `alias: { "@acme/ui": path.resolve("../ui/src") }` in
a bundler's configuration, says where an import of `@acme/ui` would be found.
Only a file that imports the name reads the package, and that file names it.
So an entry keyed by a package's name is left out, in code only when its value
does nothing but build a path. A shared configuration that lists an alias for
every package would otherwise make every package reach every other.

Files git ignores are never inputs. They are made from files that are.

A step reads the whole repository (`**`) when a script it runs calls a tool
that works across packages or on the history (`turbo`, `nx`, `lerna`, `git`, a
package manager with `--filter` or `-r`), uses a command substitution, or the
task depends on a task of the root package.

## What each command runs

**Turborepo** runs what `dependsOn` says. `turbo run test --filter=web` runs
`web`'s `test` and every task it depends on, in every package. A package gets a
step when that walk reaches a script, even if the package has no `test` script
of its own.

**pnpm, Bun and npm** have no task graph, so nothing says that one package's
`build` does not need its dependencies' `build` first. Each package step
therefore runs the script in the package and in the packages it declares, in
the package manager's own order. A package's script runs in several steps; a
task graph removes the repeat.

## What is never split

| Left whole                                                                   | Why                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A step with a command Smithers CI does not recognize                         | It can read any file                                                                          |
| A step with shell it does not read: `$(…)`, globs, loops, subshells, `<`     | The commands it runs are not known                                                            |
| A flag it does not know, or `--affected`, `--only`, `...`, `[ref]` selectors | The set of packages depends on more than the files                                            |
| A script run through a wrapper, such as `bun scripts/run-turbo.ts run build` | The wrapper may do anything with its arguments                                                |
| A root script with a `pre` or `post` hook, or more than one command          | The hook reads files no package owns                                                          |
| A workspace pattern with braces, classes or `?`; a package with no name      | The package manager may see packages Smithers CI does not                                     |
| pnpm with `tasks` in `pnpm-workspace.yaml`                                   | pnpm orders tasks from a configuration Smithers CI does not run                               |
| A selector that matches the root package, when the root has the script       | The root package's script reads the whole repository                                          |
| A `turbo` task nothing defines, or a task of the root package (`//#task`)    | Turborepo refuses the first; the second reads everything                                      |
| A step that a later step of its job follows                                  | The later step reads what it left as one step's files. It keeps its command and gains inputs  |
| A step that follows another step in its working tree                         | It can read what that step wrote. See [A step after another step](#a-step-after-another-step) |
| A step still holding a `${{ matrix.… }}` expression                          | Its command differs per variant                                                               |

A step that runs several recognized commands, or pipes one into `tee`, keeps
its command and reads what all of them read. It is split only when the run is
the step's one command, apart from lines such as `set -euo pipefail`.

## A script that runs other scripts

`npm run check` is often several checks in one command:

```json
{
  "scripts": {
    "check": "npm run check:type && npm run check:lint && npm run check:format",
    "check:type": "tsc -p .",
    "check:lint": "eslint .",
    "check:format": "prettier --check ."
  }
}
```

As one step, a change that only the format check reads runs the type check and
the lint again. Smithers CI makes one step per script the chain runs. Each step
has its own record of what it read, so it runs again only when one of those
files changes.

```text
npm run check        ──>     npm run check:type      reads the sources and tsconfig.json
                             npm run check:lint      reads the sources and the ESLint settings
                             npm run check:format    reads every file Prettier formats
```

The steps run in the chain's order. `&&` stops at the first failure, so a step
after a failed one does not run, and the report names the script that failed.
The replay compares the original step's verdict with the verdicts of its
scripts taken together: failed if any failed.

A script that the chain runs and that is itself such a chain is split again, to
any depth. Any other script is run by the command the chain wrote for it, its
`pre` and `post` scripts included.

The same holds for `npm run-script`, `npm test`, `pnpm run <script>`,
`pnpm <script>`, `yarn run <script>`, `yarn <script>` and `bun run <script>`.

A chain is split wherever its step stands in its job, after an install and
before other steps: its scripts keep their order, so each still finds what the
steps and the scripts before it left.

### What a split keeps

A package manager does more than start a script's command. Each step of a split
keeps all of it:

| The package manager                                                 | A step of a split                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Puts `node_modules/.bin` on `PATH`                                  | Runs its script through the package manager, which does the same              |
| Sets `npm_lifecycle_event`, `npm_lifecycle_script`, `npm_package_*` | The same: the package manager sets them for the script it runs                |
| Runs `pre<script>` and `post<script>`                               | The same, for the script the step runs. The script that was split has neither |
| Starts the script in the directory of its `package.json`            | Starts there too                                                              |
| Reads the script's text with a shell                                | Needs none: its command is plain words, which every shell reads the same      |
| Finds `npm` itself in `node_modules/.bin` first, inside a script    | Looks in the same directories first                                           |
| Yarn 1 leaves `npm_config_argv` and `YARN_WRAP_OUTPUT` set          | Sets both to what the outer `yarn` left                                       |

So a step's command is the chain's own words, found where the script found
them:

```text
PATH="$PWD/node_modules/.bin:$PATH" npm run check:lint
```

A script run this way gets the same environment, variable for variable, as it
gets inside `npm run check`. This is tested with npm, pnpm, Yarn 1 and Bun. Two
variables are a shell's own and are left as they fall:

- `SHLVL` counts shells. A step of a split runs under fewer, so where the
  script's shell is bash (Bun on any system; npm, pnpm and Yarn on macOS) it is
  lower by one for each script that ran around the step.
- `_` names the program a shell last started. It differs only when the package
  installs a package manager of its own: it then names that one, where inside
  the whole script it names the machine's.

### Why a script stays one step

A script is split only when each step runs exactly what it ran inside the whole
script. Otherwise the step stays as it was, and `smithers-ci inventory` says
why:

| Reason             | The step stays one step because                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `script-arguments` | the step gives the script `WORDS`, which the package manager passes on or reads itself                                          |
| `script-command`   | the script runs `COMMAND`, which is not another script of the same package.json, run by the same package manager with no option |
| `script-cycle`     | the script `SCRIPT` runs itself                                                                                                 |
| `script-first`     | the step is the first of its job and others follow it, and what it leaves for them is kept for the whole script                 |
| `script-hook`      | the script has the hook `HOOK`, which the package manager runs with it                                                          |
| `script-limit`     | the step has a time limit, which is for the whole script                                                                        |
| `script-release`   | it runs under RELEASE, where a script inside a script was not checked                                                           |
| `script-setting`   | SETTING changes how the package manager runs a script                                                                           |
| `script-syntax`    | the script WHAT                                                                                                                 |

- **`script-syntax`.** The script's text must be plain words joined by `&&`. A
  `;`, `||`, `|`, `&`, a subshell, a redirection, a variable, a quote or a
  pattern the shell expands leaves it whole.
- **`script-command`.** A link that is a command of its own, such as `tsc -p .`,
  `cd app` or `CI=1 npm run lint`, gets its `PATH` and its `npm_*` variables
  from the script around it. Run alone it would lose them.
- **`script-first`.** A step can leave values for the steps after it, as a
  GitHub Actions step does through `GITHUB_ENV`, `GITHUB_OUTPUT` and
  `GITHUB_PATH`. A job's first step starts the place they are kept in. Run
  once per script, only the last script's values would be there.
- **`script-setting`.** `script-shell`, `shell-emulator` or Bun's `shell` in a
  settings file of the repository, or a variable such as `npm_config_loglevel`
  on the step.
- **`script-release`.** npm 6 or earlier, pnpm 7 or earlier, and Yarn 2 or
  later.

## Held to its inputs

A target made from a step with inputs runs in Smithers build's sandbox: it can
read its inputs and nothing else in the repository. A read outside them fails
the target. It never passes on a result from before the file changed.

```text
grep: packages/b/input.txt: No such file or directory
sandbox: packages/b/input.txt is outside the declared read set
```

This is what makes a missing input safe. Inputs come from reading files, never
from running them, so one kind of read is not found: a path built while the
program runs. `join(root, "packages", name)` names no package in the text; a
path written whole, such as `join(root, "packages/ui")`, is found. Under the
sandbox such a read fails where it would have passed stale.

The sandbox also refuses a write outside a target's declared outputs. A package
step that writes anywhere else, as Turborepo does to `.turbo/cache` and a test
runner does to its own cache, fails under the sandbox, and the replay reports
the difference from your CI.

Three kinds of target run in the open, as an unsplit step does:

- A step with no inputs. What it reads is recorded when it runs, and it runs
  again only when one of those files changes: see
  [How it works](how-it-works.md#2-targets).
- A step a later step follows. Its reads are recorded too, and what it left
  for the later step is kept: when that step has to run, the files are put
  back and this step does not run. It declares no files, unless it names what
  it reads and what it writes; then it always runs.
- A step that follows a step that does not name what it reads and writes. Its
  reads are recorded in the same way.

When the targets' inputs would make the generated workspace larger than the
1 MiB Smithers build reads, every target runs in the open with its reads
recorded.

## A step after another step

Steps of one job run in one working tree, so a step can read what an earlier
step wrote: installed packages, a `dist` directory, a build cache.

```text
step 1   cp config/value packages/a/dist/out
step 2   grep -q good packages/a/dist/out        would read packages/a/**
```

Held to `packages/a/**`, step 2 could not read `dist/out`, which git ignores.
Allowed to read it, step 2 would still have a key made of `packages/a/**`: a
change to `config/value` rebuilds `dist/out`, the key stays the same, and the
old pass is replayed.

So a step that follows another is held to its inputs only when every earlier
step in its working tree names both what it reads and what it writes:

| The earlier steps                              | The step after them                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Each names what it reads and what it writes    | Stays narrowed. It can read what they wrote, and its key holds what they read   |
| One does not name what it reads, or its writes | Runs in the open with its reads recorded. It reruns when a file it read changes |

An earlier step that names both becomes a target that declares both. Smithers
build lets a target read the outputs of the targets it depends on, and puts
their keys in its key. A change to `config/value` then changes the key of
step 2, and step 2 runs again.

A step's outputs are a directory (`packages/a/dist/**`) or a file. Smithers
build fails a target that leaves a declared directory missing or empty, so an
output is declared only when the step is known to write it.

Jobs of a GitHub Actions workflow run on separate machines, so a job's first
step follows nothing, whatever the job needs. Its targets run in a checkout, a
home and a temporary directory of the job's own, and no step of such a job is
held to its inputs: see
[A job is a machine](how-it-works.md#a-job-is-a-machine). A job that is one
step held to its inputs needs none. Recipes of one Justfile run one
after another in one working tree, in the order `just ci` runs them: each
recipe follows the one before it, and a recipe that fails skips the rest.

## A step that runs Zig

A step that runs `zig build` names no inputs, so it is never held to a list
of files. Zig's tests write where they start: `std.testing.tmpDir` makes
`.zig-cache/tmp` beside `build.zig` and stops the test when it cannot. The
step runs in the open and what it reads is recorded: it runs again only when
one of those files changes. For a build those are the files the compiler
read, Zig's own among them, so another Zig release runs it again.

```text
just ci        tidy     etc/scripts/tidy.sh     runs again when a file it read changed
               test     zig build test          runs again when a file it read changed
```

When the step is nothing but `zig build <step>` and that build step only
groups named steps, it becomes one step per named step. Each has a record of
its own, so a change runs again only the steps whose own run read it. Zig ran
those named steps at the same time, and the steps still run at the same time.

A flag that only changes how the run is reported or how much runs at once is
given to each of them: `zig build test --summary all` becomes
`zig build test-core --summary all` and the others. Those flags are
`--summary`, `--color`, `--error-style`, `--multiline-errors`, `--verbose`,
`--test-timeout`, `--seed`, `-j<N>` and `-freference-trace`. Any other flag
keeps the step whole: `-Doptimize=ReleaseSafe` changes what is built, and a
build can name other steps for it.

A Zig step keeps Zig's two caches with Smithers CI's own, outside your
checkout (see [Where the cache is on a machine](cache.md#where-the-cache-is-on-a-machine)).
They last from one run to the next, and the generated workflow saves them with
the results: a
step that does run again compiles and reruns only the binaries the change
reaches, by Zig's own rules. What Zig reads and writes in its cache is left
out of the step's record.

Every step that starts `zig` keeps its caches there, whatever else the step
does:

```text
zig build test --summary all            a flag
zig test src/main.zig                   another Zig command
make deps && zig build test             beside another program
working-directory: tools/gen            a project in a directory under the root
```

Zig's usual cache is `.zig-cache` beside `build.zig`. A step reads it, and a
fresh checkout does not have it, so with the cache left there the step would
run again on every CI run. A step that starts in `tools/gen` is given the
same cache directory as a step at the root. Three
steps keep Zig's usual place: one that changes directory with `cd` or starts
outside the repository; one whose command names `.zig-cache`; and one whose
shell holds a loop, a subshell or a program named by a variable.

A Zig step that a later step follows keeps its command as it is, and Zig
keeps its cache where it always does: the later step may read what it built.

## One cost

Every mention of a package counts, used or not, unless it is an alias. A
package that lists others by name in a catalog reaches all of them, so its
step reruns when any of them changes. This costs time, never correctness.

## How this compares

|                                    | Turborepo                              | Nx                                        | Smithers CI                              |
| ---------------------------------- | -------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| A package task reads its own files | Yes, or its `inputs`                   | Yes, or its `inputs`                      | Yes, always the whole directory          |
| It reads its dependencies' files   | Only through `dependsOn: ["^task"]`    | Yes, by default                           | Yes, always                              |
| Dependencies come from             | `package.json`                         | `package.json` and imports in source      | `package.json`, names and paths in files |
| `inputs` can leave files out       | Yes                                    | Yes                                       | No. `inputs` only add files              |
| Root files that rerun everything   | `globalDependencies`, root manifest    | `nx.json`, named `{workspaceRoot}` inputs | Every file outside all packages          |
| A lockfile change                  | Reruns packages whose packages changed | Reruns everything, unless set to `auto`   | Reruns everything                        |

Where Smithers CI differs, it reads more:

- Turborepo's hash of a task leaves out a dependency's source unless the task
  declares `^task`. Its documentation shows the result: a task that "doesn't
  account for source code changes in dependencies" and "will show a successful
  cache hit, despite not being updated". A package step always reads the
  packages it reaches.
- An `inputs` list is the owner's claim that a task reads nothing else.
  Smithers CI cannot check the claim, so it never uses one to read less.
- Nx finds undeclared dependencies from `import` and `require` in source.
  Smithers CI also follows relative and root paths, because a script such as
  `node ../../tools/build.mjs` is how a package reads another without
  importing it.

## Sources

- Turborepo, [Caching](https://turborepo.dev/docs/crafting-your-repository/caching):
  what the global hash and a package's hash hold.
- Turborepo, [Configuring tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
  "Dependent tasks that can be run in parallel": the quotations above.
- Turborepo, [Package and task graphs](https://turborepo.dev/docs/core-concepts/package-and-task-graph):
  a package without the script stays in the graph so its dependencies run.
- Turborepo, [`run`](https://turborepo.dev/docs/reference/run): `--filter` also
  runs the tasks a task depends on; `--affected`.
- Turborepo, [Configuration](https://turborepo.dev/docs/reference/configuration)
  and [Package configurations](https://turborepo.dev/docs/reference/package-configurations):
  `inputs`, `$TURBO_ROOT$`, `globalDependencies`, `$TURBO_EXTENDS$`.
- Turborepo source, `crates/turborepo-task-hash/src/lib.rs` (`TaskHashable`)
  and `crates/turborepo-engine/src/builder.rs`, at commit `9e884b49f67f`.
- Nx, [Inputs and named inputs](https://nx.dev/docs/reference/inputs): "By
  default, Nx will use all files in a project as well as all files in the
  project's dependencies".
- Nx, [Affected](https://nx.dev/docs/features/ci-features/affected), and source
  `packages/nx/src/plugins/js/project-graph/build-dependencies/explicit-project-dependencies.ts`,
  at commit `cd0630bb20d5`.
- pnpm, [`pnpm run`](https://pnpm.io/cli/run), [Filtering](https://pnpm.io/filtering)
  and [Workspace task orchestration](https://pnpm.io/workspace-task-orchestration):
  "A task with no entry under `tasks` defaults to depending on the same task in
  its workspace dependencies."
- Bun, [`bun --filter`](https://bun.com/docs/pm/filter): "Bun respects package
  dependency order when running scripts."
- npm, [Workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces).

## See also

- [How it works](how-it-works.md)
- [Normal mode and fast mode](modes.md)
