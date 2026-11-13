# smithers build API review

## Read in this order

1. `PACKAGE.ts` shows the declared toolchain, the declared secrets, the
   generated root files, the real install target, shared root inputs, and the
   explicit package target maps.
2. `packages/smithers/flows/engine/PACKAGE.ts` shows `StandardPackage` plus one extra
   policy target. `packages/smithers/flows/flow/PACKAGE.ts` shows the same package
   longhand. `packages/smithers/flows/plan/PACKAGE.ts` shows the bare macro.
3. `packages/smithers/build/targets/src/StandardPackage.ts` expands a conventional package into `lib`,
   `test`, and `lint`.
4. `packages/smithers/build/targets/src/Target.ts` defines `Target.make`. Attrs are an Effect Struct schema.
   The implementation is the required pure Flow body. A rule call returns a
   Flow with planner metadata attached.
5. `packages/smithers/build/targets/src/TsBuild.ts` is a representative catalog rule.
   `packages/smithers/build/targets/src/LlmLint.ts` shows a git diff as declared key material.
6. `packages/smithers/build/targets/src/WorkspaceDeclaration.ts` defines the inert
   workspace configuration exported from `WORKSPACE.ts`.
7. `packages/smithers/build/build-cli/src/Cli.ts` defines the incur verbs. `packages/smithers/build/build-cli/src/Workspace.ts` handles lazy
   PACKAGE.ts loading and cache-directory resolution. `packages/smithers/build/build-cli/src/Planner.ts`
   constructs the target graph and key preview. `packages/smithers/build/build-cli/src/engine.ts` isolates
   install-runtime assumptions.

## Workspace configuration

The workspace declaration lives in `.smithers/WORKSPACE.ts` or the root
`WORKSPACE.ts` fallback and exports one `Workspace` value. It is inert: the
constructor validates and performs no I/O. Cache settings, including a remote,
belong in `Workspace.cache`, declared with `Smithers.Cache({ directory, remote })`.
Every command resolves the cache directory as `--cache-dir`, then that
declaration, then `.flows`, and applies the declared gitignore policy before
touching the directory.

The resolved directory is host state, never attrs and never key material.
Discovery, the recursive fallback listing, and glob expansion all exclude it
unconditionally. Manager store paths stay fixed at `.flows/store/<manager>`
and are excluded independently because they are declared `TreeArtifact`
boundaries; configurable store placement is future work.

## Labels

Labels come only from a `PACKAGE.ts` path and its exported `Package.targets` keys.
A top-level target export fails with `naked_target_export`.

- `//path/to/pkg:target` addresses one map key.
- `//path/to/pkg` selects the explicit `default` key. Without that key it fails
  with `no_default_target`; no other target name is a fallback.
- `//...` selects every target in discovered `Package` maps.
- `//path/...` selects a subtree.
- `:target` selects a map key in the current package.
- The root install target is `//:nodeModules`. To also select it with `//`,
  add `default: Smithers.Alias(nodeModules)` to that map.

Import another module's `Package` map and select its target value to form a
dependency edge. Labels never appear in rule attrs.
`glob()` and `file()` create declared values and perform no I/O during module
evaluation. The planner expands and digests them later.

## Execution status

Every catalog rule is implemented. No rule ends in `NotImplemented`; only the
`Target.ts` stub machinery remains, for future catalog additions.

Every tool-running rule takes the declared package manager as a required attr
and derives its argv from it. Rules that evaluate an inline program take the
declared runtime instead. Nothing in the catalog spells `pnpm` or `node` into
an argv of its own.

`build`, `test`, and `lint` execute their plans by default. The executor runs
targets in dependency order with bounded parallelism (`--jobs`), keep-going
semantics (a failure skips only its dependent cone), and per-target cache
lookups keyed by the planner key preview. Green cacheable results are stored
in the workspace cache under `<cacheDirectory>/cache` or the HTTP `/ac` remote
declared by `RemoteCache`; `SMITHERS_CACHE_URL` overrides its endpoint and
`--no-cache` bypasses reads while still writing.
`--plan` prints the inert structured plan instead of executing. `ci` merges
the build, test, and lint plans over one pattern. `query` and `graph` stay
inert. `smithers-build install` plans and executes the `Install.Install` Flow over the layer
the declared toolchain selects; the root `Install` target calls the same Flow
with the declared manager as its payload. The executor derives both the
package-manager layer and the runtime layer from each target's own attrs, so
two targets in one graph may run under different managers.

The CLI process entry point captures `SMITHERS_CACHE_URL` and the default
`SMITHERS_CACHE_TOKEN` once during startup and deletes both from `process.env`.
That is a choice only a process owner may make; the programmatic `makeCli`
surface reads the declared token variable and never deletes it, because two
concurrent callers would otherwise erase each other's credentials. The root
declaration carries only an endpoint and token environment-variable name. The
shared exec runner removes both the URL override and the resolved token
variable after merging a payload's environment, so a target cannot reintroduce
either capability and a declaration's custom token variable never reaches a
tool child.

Exec working directories and generated-file paths are confined to the
canonical workspace root. Lexical escapes, absolute paths outside the root,
and paths crossing an in-workspace symlink to an outside location fail with a
typed execution or drift error. Exec streams output live while retaining only
a bounded head and tail, includes stdout and stderr tails in failures, and
interrupts the detached child process group when the CLI receives SIGINT or
SIGTERM.

Every key carries the rule implementation digest, Node version, platform,
architecture, and workspace `pnpm-lock.yaml` digest. `EXECUTION_FORMAT` in
`packages/smithers/build/build-cli/src/Planner.ts` is the global executor-semantics salt. Increment it when
executor behavior changes without otherwise changing key material.

Each target executes through a fresh in-memory flows runtime because two
targets of one rule share a Flow tag (open question 1). A rule that chains two
keyless `Exec` steps passes the first step's planned result through the second
payload's `after` field. That reference is a material dependency the engine
settles before dispatch; without it both keyless execs dispatch at once and
the engine refuses with `ConcurrentKeylessDispatch`. `captureOutputs` takes
the producing step's planned result for this reason.

The CLI does not consume `PackageDefaults` exports or synthesize targets for
directories containing only `package.json`. Each package needs an explicit
`PACKAGE.ts` exporting a `Package` map. A shared macro can populate that map
when called explicitly. Every tool-running rule has a `cwd` attr
defaulting to the workspace root; package-level PACKAGE.ts targets pass their
own package directory.

Release targets carry planner-level verb gates. `NpmPublish` and `JsrPublish`
may appear only in a `run` graph, including through dependencies. They default
to `dryRun: true`; `dryRun: false` enables real publication.
`Changesets.Version` applies versioning under `run` and checks drift under
`lint`. `Changesets.Publish` has a separate outward-action gate that currently
refuses publication.

Generated package manifests and GitHub workflows resolve their declared
check-mode input and their read or write action from the same workspace-rooted
path. GitHub workflow generation emits one compact `ci` command for the exact
build, test, and lint set, and otherwise emits one command per declared kind.

## Known limitations

- artifact store not yet wired; hits are validated, not materialized.
- Environment variables stay out of keys for now.
- General closure problem (tsconfig extends chains, config imports,
  gitignored-but-compiled files).

## Open API questions

1. A target is currently a Flow tagged by rule id, plus symbol metadata. Two
   `TsBuild` targets therefore share a Flow tag even though their target labels
   differ. The executor works around it with a fresh runtime per target.
   Decide whether the loader should bind a path-derived Flow tag after
   export discovery or whether target identity should remain outside Flow.
2. A rule call cannot know its export name. Metadata captures the PACKAGE.ts
   call-site path from the stack so the lazy loader can find a direct imported
   dependency without evaluating unrelated modules. Decide whether this hint
   is acceptable or whether the runtime needs a loader-owned module registry.
3. `PackageDefaults` helpers exist, but the loader and index do not consume
   their exports. Automatic discovery and dependency-edge inference would need
   integration and tests before they can replace explicit `Package` maps.
4. Decide whether `StandardPackage` should expose `typecheck`, declaration
   build, and formatting as separate targets or keep the review surface at
   exactly `lib`, `test`, and `lint`.
5. Key previews carry `body`, `inputs`, `layers`, and `capabilities`, and the
   preview digest is now the executor's cache key. Layer and capability lists
   are still hand-maintained catalog declarations in `packages/smithers/build/build-cli/src/Planner.ts`.
   Executable rules should eventually derive them from the real Flow graph and
   resolved Layers.
6. Source distributions use a JavaScript bin bootstrap plus tsx to evaluate
   TypeScript. Decide whether the published CLI ships compiled JavaScript while
   retaining tsx only for PACKAGE.ts evaluation.

## Install-package seam

`packages/smithers/build/targets/src/Install.ts` and `packages/smithers/build/build-cli/src/engine.ts`
are reconciled against the current install package: the Install payload is
`{ manager }`, the workspace root is the engine's working directory, and the
executor and `runInstall` move there through `withWorkingDirectory`. All
CLI-side runtime assumptions stay confined to
`packages/smithers/build/build-cli/src/engine.ts`.

The duplication that used to sit here is gone. The rule declares the lockfile,
`.npmrc`, and root manifest as its own inputs, and the Flow no longer measures
the manager it runs under: the manager is the PACKAGE.ts declaration, and the
services hold the host to it.
