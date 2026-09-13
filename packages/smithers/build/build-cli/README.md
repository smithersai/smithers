# smithers-build CLI

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://build-cli.smithers.sh

`smithers-build` executes target graphs. A verb selects a set of targets by
label or pattern, the CLI plans them, consults a content-addressed cache, and
runs whatever is missing. Targets declare inputs, outputs, and permissions;
they never contain per-command scripts.

```sh
smithers-build install --workspace /path/to/smithers
smithers-build ci //packages/...
smithers-build test //packages/smithers/flows/flow:test
smithers-build lint //packages/smithers/flows/flow:lint
smithers-build query 'deps(//packages/smithers/flows/flow:lib)'
smithers-build graph //packages/... --mermaid
smithers-build //packages/smithers/flows/flow:lint          # the bare-label form
```

Verbs execute by default. `--plan` prints the inert plan instead, `--no-cache`
bypasses cache reads, and `--jobs` bounds concurrency. `install` runs the
install Flow under the declared package manager.

The CLI loads `.smithers/WORKSPACE.ts` (or a root `WORKSPACE.ts`) and every
`PACKAGE.ts` in the tree. The workspace declaration names the shared services:
runtimes, package managers, toolchains, sandbox mechanisms, and caching. Each
package exports exactly one `S.Package({ targets })`, selected through
Bazel-style labels.

Install the current release candidate with
`pnpm add -D @smthrs/build-cli@next @smthrs/targets@next`.

## Documentation

The full site is at https://build-cli.smithers.sh, generated from
[`docs/`](./docs/README.md):

- [Installation](./docs/installation.md) and
  [Quickstart](./docs/quickstart.md).
- [Declaration loading](./docs/concepts/declaration-loading.md): shared runtime
  dependencies, conflict diagnostics, module formats, and evaluation lifetime.
- [Commands](./docs/cli.md): every command, argument, option, exit code, and
  environment variable.
- Concepts: [the invocation pipeline](./docs/concepts/invocation.md),
  [workspace discovery](./docs/concepts/discovery.md),
  [output and renderers](./docs/concepts/output.md),
  [caching](./docs/concepts/caching.md), and
  [target execution](./docs/concepts/execution.md).
- [Rule contracts and ownership](./docs/concepts/rule-contracts.md): the
  declaration boundary, shared execution services, and staged family extraction.
- Guides: [selecting targets](./docs/guides/select-targets.md),
  [inspecting a workspace](./docs/guides/inspect-a-workspace.md),
  [remote caching](./docs/guides/share-a-remote-cache.md),
  [scaffolding an app](./docs/guides/scaffold-an-app.md), and
  [embedding the CLI](./docs/guides/embed-the-cli.md).
- [Troubleshooting](./docs/troubleshooting.md) and the
  [API reference](./docs/api.md).

The API reference is derived from the JSDoc on the exported declarations in
`src/`; the package's lint configuration requires a description, a
`@category`, and a `@since` on each one.
