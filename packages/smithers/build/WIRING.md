# Wiring

`@smthrs/build` is a pnpm workspace package of the Smithers repository at
`packages/smithers/build`, alongside the private `@smthrs/targets` and `@smthrs/build-cli`
packages. The workspace install links everything; there is no separate
install step.

## Compile-time dependencies

| Dependency       | Version        | Use                                            |
| ---------------- | -------------- | ---------------------------------------------- |
| `effect`         | `4.0.0-rc.115` | Effects, schemas, layers, files, and processes |
| `@smthrs/flow`   | `1.0.0-rc.0`   | Actions, flows, annotations, and file inputs   |
| `@smthrs/plan`   | `1.0.0-rc.0`   | Planned nodes                                  |
| `@smthrs/crypto` | `1.0.0-rc.0`   | SHA-256 digests                                |

The build CLI additionally uses the Smithers engine, action implementations,
and Node platform services declared in `../build-cli/package.json`.

## Workspace membership

The Smithers checkout uses pnpm. Its `pnpm-workspace.yaml` includes
`packages/*` and `packages/smithers/build/infra`.

1. The three packages live at `packages/smithers/build`, `packages/smithers/build/targets`,
   and `packages/smithers/build/build-cli`.
2. Published runtime dependencies use exact `1.0.0-rc.0` versions. Private
   tooling edges use `workspace:*`. `linkWorkspacePackages` resolves both to
   local packages; no `file:` or `link:` specifiers remain.
3. The root `pnpm install` creates the package links and owns the single
   `pnpm-lock.yaml`. The old per-package npm lockfiles are deleted.
4. `pnpm --filter @smthrs/build check` typechecks the library. The
   root `pnpm check` recurses into every package, including `targets`,
   `build-cli`, and `infra`.

No TypeScript path mapping is required. `tsconfig.json`, the build scripts,
the source export map, and the pinned tooling dependencies copy the current
`@smthrs/flow` package shape. The export map resolves to `src/*.ts`, because
the package is private and every consumer of it is in this workspace; a
published dual ESM/CJS map is what a `publishConfig` would carry, and this
package has none.

## PACKAGE.ts imports

The Smithers workspace root declares `"@smthrs/targets": "workspace:*"` and
`"@smthrs/build-cli": "workspace:*"` as devDependencies. `PACKAGE.ts` files
import the rule catalog by bare specifier: `import { ... } from
"@smthrs/targets"`, and `pnpm exec smithers-build` resolves the build CLI's
workspace bin.

Embedding the install flow requires:

- an `Install.layer` containing its action implementations;
- an interpreter registration for `Install.Install` so the runtime can
  resolve the flow by tag;
- a `FlowRuntime`;
- Node `FileSystem`, `ChildProcessSpawner`, and `Crypto` services;
- one `PackageManager` layer.

Only `PackageManager.layerPnpm` performs work today. `layerBun` resolves the
service but fails every operation with a typed `unsupported` error.

The pnpm layer is constructed with an absolute project root and the version the
workspace declared, over a runtime layer carrying the host facts:

```ts
PackageManager.layerPnpm({
  projectRoot: "/absolute/workspace",
  requirement: ">=11.0.0"
}).pipe(
  Layer.provide(Runtime.layerNode({
    requirement: ">=22.19.0",
    platform: { os: "linux", arch: "x64", libc: "glibc" },
    environment: process.env
  }))
)
```

The platform is not a package-manager option: it moved to the `Runtime`
service, and `normalizeOptions` refuses it as an unknown property. The manager
takes it from that service.

Optional construction values are a bounded command timeout, an executable
override, and an environment snapshot. A manager child does not inherit the
complete host environment: the layer selects bootstrap and network variables
plus the variables the project `.npmrc` references, clears user and global npm
config, refuses embedded credentials and process-control variable references,
and passes both `env` and `extendEnv: false`.

`Runtime` takes the same `environment` snapshot, and selects only the four
executable-lookup names out of it for the version probe. Passing it is what
makes the probe hermetic: `extendEnv: false` on its own selects nothing,
because Effect returns an absent `env` unchanged and a spawn with no `env`
inherits everything. A runtime layer built without an `environment` still
inherits, so a composition root that spawns a workspace-declared interpreter
should always pass one.

`../build-cli/src/engine.ts` is the production composition. It uses an
in-memory flows runtime per invocation, anchors the package-manager service to
the canonical workspace root, and never changes process-wide `cwd`. The
`install` command requires the default `.flows` configuration because the
declared store boundary is fixed at `.flows/store/pnpm`.

## Target executor composition

Each selected target gets a fresh in-memory runtime so two targets built from
the same rule tag cannot alias each other's flow registration. The executor
provides implementations for:

- shared process execution and output capture;
- generated-file write/check and package-manifest synchronization;
- declared-output verification and filegroup expansion;
- install actions under pnpm;
- GitHub workflow checks, documentation parity, LLM review, and package
  scaffolding.

Irreversible release actions are intentionally absent. A `Changesets` version,
`NpmPublish`, or `JsrPublish` target therefore refuses with
`unresolved_action` instead of mutating external state through the ordinary
executor.

## Cache-directory host state

For normal target verbs the CLI resolves `--cache-dir`, then the root
`Workspace` declaration, then `.flows`. Target results live below
`<cacheDirectory>/cache`; rule scratch files use the same root.

The real directory is not action payload or key material. Rules that need it
emit a constant token and `ExecLive` substitutes the validated host value just
before spawn. Discovery and glob expansion receive the same resolved value and
exclude it explicitly. The fixed `.flows/store` install tree is excluded
separately.

## Remote caches

The `smithers-build` target-result cache speaks `/ac` directly. `RemoteCacheStore` and
`RemoteArtifacts` in the Smithers engine are a different composition: they store
engine step rows and artifact blobs through `/ac` and `/cas`. The `smithers-build` CLI
does not provide those engine layers today.

An embedding host that needs engine-level remote artifacts must compose those
layers with its local step cache and artifact store itself. Endpoint and
authorization values are host capabilities and must not enter step-key
material.

## Current boundary limit

Install fetch actions declare `.flows/store/<manager>` as a `TreeArtifact`, but
their boundary mode is `expected`. The current absolute-root manager process
cannot freeze the lockfile and `.npmrc` across the child's own opens, and the
unsandboxed filesystem observer cannot attest that nothing else was read or
written. Consequently install results and store trees are not published to a
cross-run engine cache. Wiring a sandbox that produces hermetic-read and
whole-tree evidence is required before changing that admission policy.
