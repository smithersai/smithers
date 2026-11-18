---
title: "Splitting a step"
description: "How smithers-ci turns one CI step that runs a task over a whole workspace into one step per package, what each of those steps reads, and which steps it never splits."
---

A CI step such as `turbo run test` reads the whole repository, so every change
reruns it. Smithers CI splits such a step into one step per package, and names
the files each one reads. A change then reruns only the steps that read a file
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

| The step runs                                                    | It becomes                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `turbo run <task>` or `turbo <task>`, with or without `--filter` | One `turbo run <task> --filter=<package>` per package with work          |
| `pnpm -r run <script>`, `pnpm --filter <selector> run <script>`  | One `pnpm --filter=<package>… run <script>` per package                  |
| `bun run --filter <pattern> <script>`, `bun run --workspaces`    | One `bun run --filter <package>… <script>` per package                   |
| `npm run <script> --workspaces`, `--workspace <name>`            | One `npm run <script> --workspace=<package>…` per package                |
| A root script that is one of the commands above, as `pnpm test`  | The same, from the root script's own command and the words the step adds |
| One package's script, as `bun run --cwd packages/core test`      | The same command, with its inputs named                                  |
| `zig build <step>`                                               | The same command, with the files of the step's closure as inputs         |

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
     `ui` only in quotes, after `node_modules/`, or in a `package.json`;
   - paths its files write that lead into another package: `../ui/src/a.ts`,
     or `packages/ui/src/a.ts` from the root. A path that names a file adds
     that file and what the file itself names. Any other path into a package
     adds the whole package. A symbolic link counts as the path it points to.
4. **What Turborepo's configuration declares:** `globalDependencies`, and task
   `inputs` that start with `$TURBO_ROOT$` or leave the package.

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

| Left whole                                                                   | Why                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A step with a command Smithers CI does not recognize                         | It can read any file                                            |
| A step with shell it does not read: `$(…)`, globs, loops, subshells, `<`     | The commands it runs are not known                              |
| A flag it does not know, or `--affected`, `--only`, `...`, `[ref]` selectors | The set of packages depends on more than the files              |
| A script run through a wrapper, such as `bun scripts/run-turbo.ts run build` | The wrapper may do anything with its arguments                  |
| A root script with a `pre` or `post` hook, or more than one command          | The hook reads files no package owns                            |
| A workspace pattern with braces, classes or `?`; a package with no name      | The package manager may see packages Smithers CI does not       |
| pnpm with `tasks` in `pnpm-workspace.yaml`                                   | pnpm orders tasks from a configuration Smithers CI does not run |
| A selector that matches the root package, when the root has the script       | The root package's script reads the whole repository            |
| A `turbo` task nothing defines, or a task of the root package (`//#task`)    | Turborepo refuses the first; the second reads everything        |
| A step still holding a `${{ matrix.… }}` expression                          | Its command differs per variant                                 |
| A Zig build step whose closure has an import it could not follow             | An incomplete closure is affected by every change               |

A step that runs several recognized commands, or pipes one into `tee`, keeps
its command and reads what all of them read. It is split only when the run is
the step's one command, apart from lines such as `set -euo pipefail`.

## Two limits

Inputs come from reading files, never from running them.

- **A path built while the program runs is not seen.** `join(root, "packages",
  name)` names no package in the text. A path written whole, such as
  `join(root, "packages/ui")`, is found. Running package steps in a sandbox
  that refuses reads outside their inputs turns such a read from a wrong pass
  into a failure. Until generated targets run that way, the replay is the
  check: it runs the original step and the package steps on the same commits
  and reports every verdict that differs.
- **Every mention of a package counts, used or not.** A package that lists
  others by name in a catalog reaches all of them, so its step reruns when any
  of them changes. This costs time, never correctness.

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
