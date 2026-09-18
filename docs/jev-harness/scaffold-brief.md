# Scaffold brief: `@smthrs/opencode` and `smithers opencode`

Probe date: 2026-09-17. Main at `73b6d6ce`. Every claim below was run in a throwaway
jj workspace (`jj workspace add ../smithers-scaffold-probe -r main`, real
`pnpm install`), then the workspace was forgotten and deleted. Nothing was committed.

## 0. What the probe proved

- `pnpm install --frozen-lockfile --ignore-scripts` passes on main (53 s, working copy unchanged). The 2026-09-10 alchemy drift is gone.
- A new package at `packages/smithers/opencode` needs no edit to `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json`, or `.github/workflows/ci.yml`. `smthrs lint '//:tsconfig'` and `smthrs lint '//:ci'` stay clean.
- It does need: `.smithers/target-index.json` regenerated, the release roster in `scripts/pack-release.mjs` extended, the parent CLI package's coverage and dprint excludes extended, `bun.lock` refreshed, `pnpm-lock.yaml` extended (two hunks, 94 insertions, 0 deletions), and the site API page regenerated.
- `pnpm exec smthrs ci '//packages/smithers/opencode/...'` ran 7 targets green (lib, check, test, lint, fmt, docs, circular) once the markdown tables were dprint-formatted.
- The verb is Incur-only. `serve`, `credentials`, `triggers`, `integrations`, and `eval` prove both shapes: a verb needs no `Verb.ts` row and no `Command.ts` handler unless it also ships in the legacy Effect CLI. Adding `opencode` to `Cli.ts` alone is the whole wiring.

## 1. Package scaffold

Copy source: `packages/smithers/gateway`. Every file below is per package (not shared) except where noted. Generator: none. `packages/smithers/create-app` scaffolds user apps, not workspace packages. `Smithers.PackageDefaults` in the root `PACKAGE.ts` would synthesize targets for a directory with `package.json` and no `PACKAGE.ts`, but `apps/site/PACKAGE.ts` and the docs site import the package's `Package` export by path, so write `PACKAGE.ts`.

```bash
cd /Users/williamcory/smithers-<lane>
P=packages/smithers/opencode; G=packages/smithers/gateway
mkdir -p $P/src $P/test $P/scripts $P/docs
cp $G/tsconfig.json $G/tsconfig.test.json $G/eslint.config.js $G/dprint.json $P/
cp $G/scripts/build.mjs $G/scripts/circular.mjs $P/scripts/
cp LICENSE $P/LICENSE
sed 's/flows-gateway-coverage/flows-opencode-coverage/' $G/vitest.config.ts > $P/vitest.config.ts
```

Do not copy `gateway/scripts/check-boundary-mutations.mjs` (gateway-specific) or gateway's `ReadmeExports.test.ts`, `DocsAccuracy.test.ts`, `Index.test.ts` bodies (they name gateway modules). `SourceDocblocks.test.ts` is generic and worth copying.

### 1.1 `package.json` (verbatim, probe-verified)

```json
{
  "name": "@smthrs/opencode",
  "type": "module",
  "version": "1.0.0-rc.0",
  "license": "MIT",
  "smthrs": {
    "group": "agent"
  },
  "description": "OpenCode protocol server over the Smithers agent loop, for the hosted OpenCode app",
  "homepage": "https://github.com/smithersai/smithers",
  "repository": {
    "type": "git",
    "url": "https://github.com/smithersai/smithers.git",
    "directory": "packages/smithers/opencode"
  },
  "bugs": {
    "url": "https://github.com/smithersai/smithers/issues"
  },
  "tags": ["typescript", "effect", "opencode", "agent"],
  "keywords": ["typescript", "effect", "opencode", "agent"],
  "engines": {
    "node": ">=22.19.0"
  },
  "sideEffects": [],
  "exports": {
    "./package.json": "./package.json",
    ".": "./src/index.ts",
    "./internal/*": null,
    "./*/index": null,
    "./Serve": "./src/Serve.ts",
    "./index": "./src/index.ts"
  },
  "files": [
    "src/**/*.ts",
    "dist/**/*.js",
    "dist/**/*.js.map",
    "dist/**/*.d.ts",
    "dist/**/*.d.ts.map",
    "dist/**/package.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md"
  ],
  "publishConfig": {
    "access": "public",
    "provenance": true,
    "tag": "next",
    "exports": {
      "./package.json": "./package.json",
      ".": {
        "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
        "require": { "types": "./dist/cjs/index.d.ts", "default": "./dist/cjs/index.js" }
      },
      "./internal/*": null,
      "./*/index": null,
      "./Serve": {
        "import": { "types": "./dist/esm/Serve.d.ts", "default": "./dist/esm/Serve.js" },
        "require": { "types": "./dist/cjs/Serve.d.ts", "default": "./dist/cjs/Serve.js" }
      },
      "./index": {
        "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
        "require": { "types": "./dist/cjs/index.d.ts", "default": "./dist/cjs/index.js" }
      }
    }
  },
  "scripts": {
    "lint": "eslint src --max-warnings=0 && dprint check",
    "format": "dprint fmt",
    "build": "node scripts/build.mjs",
    "check": "tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit",
    "circular": "node scripts/circular.mjs",
    "test": "vitest",
    "coverage": "vitest --coverage"
  },
  "dependencies": {
    "@smthrs/agent": "1.0.0-rc.0",
    "@smthrs/capability": "1.0.0-rc.0",
    "@smthrs/engine": "1.0.0-rc.0",
    "@smthrs/engine-store": "1.0.0-rc.0",
    "@smthrs/flow": "1.0.0-rc.0",
    "@smthrs/flows": "1.0.0-rc.0",
    "@smthrs/harness": "1.0.0-rc.0",
    "@smthrs/kernel": "1.0.0-rc.0",
    "@smthrs/model": "1.0.0-rc.0",
    "@smthrs/registry": "1.0.0-rc.0"
  },
  "devDependencies": {
    "@effect/language-service": "0.87.2",
    "@effect/platform-node": "4.0.0-rc.115",
    "@effect/vitest": "4.0.0-rc.115",
    "@eslint/js": "9.39.5",
    "@types/node": "26.4.1",
    "@vitest/coverage-v8": "5.0.0",
    "dprint": "0.57.1",
    "effect": "4.0.0-rc.115",
    "esbuild": "0.28.2",
    "eslint": "9.39.5",
    "eslint-import-resolver-typescript": "4.4.5",
    "eslint-plugin-import": "2.32.0",
    "eslint-plugin-jsdoc": "64.3.4",
    "eslint-plugin-unicorn": "65.0.0",
    "fast-check": "4.9.0",
    "madge": "8.0.0",
    "typescript": "5.9.3",
    "typescript-eslint": "8.69.0",
    "vitest": "5.0.0"
  },
  "peerDependencies": {
    "@effect/platform-node": "4.0.0-rc.115",
    "effect": "4.0.0-rc.115"
  }
}
```

Rules the manifest is held to (`scripts/repo-contract/package-contract.test.mjs`, `scripts/public-export-map.mjs`, `scripts/pack-release.mjs`):

- `smthrs.group` must be `engine`, `agent`, or `tooling`. Use `agent` (gateway, cli, agent use it).
- A library declares `effect` as an exact peer and an exact devDependency, never a dependency. Only `@smthrs/cli`, `@smthrs/build-cli`, `@smthrs/migrate` own the runtime.
- Every `@smthrs/*` dependency pins the exact workspace version string `1.0.0-rc.0`, never `workspace:*` (published packages) .
- `exports` and `publishConfig.exports` must have identical key sets, no positive wildcard, and `"./internal/*": null` plus `"./*/index": null`. Every non-null key must point at a file that exists. One key per public module; `commands/`-style modules that stay internal need no key.
- `type: module`, `license: MIT`, `publishConfig.access: public`, `publishConfig.tag: next`, `files` non-empty and containing `LICENSE`, `exports["."]`, `exports["./package.json"]`, `repository.directory` equal to the path, `engines.node` set, and scripts `lint`, `build`, `check`, `test`, `coverage` present.
- `LICENSE` must be byte-identical to the root `LICENSE`.
- Every new `@smthrs/*` import in `src/` must be a declared dependency or peer (`scripts/check-dependency-boundaries.mjs`); tests and scripts may use devDependencies.

### 1.2 `PACKAGE.ts` (verbatim)

```ts
import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/opencode"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
```

What the macro emits (`packages/repo-targets/src/BuildAndCheckTypeScriptPackage.ts`):

| Target | Tool | Reads |
| --- | --- | --- |
| `lib` | `scripts/build.mjs` (thin per-package file that calls the shared `packages/repo-targets/scripts/build-library.mjs`, which in turn runs `packages/smithers/scripts/compile-commonjs.mjs`) | `src/**/*.ts`, `tsconfig.json` |
| `check` | `tsc -p tsconfig.test.json --noEmit` | `src`, `test`, `packages/repo-targets/test-utils/effect-property.*` |
| `test` | vitest with `vitest.config.ts`, `passWithNoTests: false`, coverage thresholds 100/100/100/100 | `test/**/*.test.ts` |
| `lint` | eslint over `src` with `eslint.config.js` and the root `eslint.jsdoc.js` | `src` |
| `fmt` | `dprint check` with `dprint.json` over `src` and `test`; the `lint` npm script also runs `dprint check` over the whole package including `docs/*.md` and `README.md` | |
| `docs` | `DocsParity`: `README.md` exists, has a level-one title, and carries at least 120 characters of prose outside badges, links, headings, lists, and code | `README.md` |
| `docsFiles` | Filegroup `docs/**/*.md`, `README.md`, `package.json`; joins no verb; imported by `apps/site/PACKAGE.ts` and the docs site | |
| `circular` | `scripts/circular.mjs` (per-package copy; madge over `src`) | `src`, `tsconfig.json` |

`vitest` needs at least one test file and 100 percent coverage of `src/**` or `test` fails. Hand-padded markdown tables fail `dprint check`; run `pnpm --filter @smthrs/opencode run format` before `lint`.

### 1.3 `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `eslint.config.js`, `dprint.json`

Byte copies of gateway's. `eslint.config.js` imports `../../../eslint.invariants.js` and `../../../eslint.jsdoc.js` (depth three, same as gateway). `vitest.config.ts` only changes the `reportsDirectory` prefix. `tsconfig.json` resolves `@smthrs/*` through the workspace symlink to each package's `./src/index.ts` export, so `check` needs no built `dist` of sibling packages.

### 1.4 Source conventions (`eslint.jsdoc.js`, root `//:jsdocTree` gate)

Every `src/*.ts` file starts with a module header block that has prose then `@since`. Every exported declaration has prose, `@since`, and a lowercase `@category`. `index.ts` is barrels only: one `export * as Name from "./Name.ts"` per module, each preceded by `/** @since 1.0.0 @category <x> */`. Probe-verified minimal pair:

```ts
// src/index.ts
/**
 * OpenCode protocol server over the Smithers agent loop.
 *
 * @since 1.0.0
 */

/**
 * @since 1.0.0 @category serve
 */
export * as Serve from "./Serve.ts"
```

```ts
// src/Serve.ts
/**
 * The bind the `smithers opencode` server listens on.
 *
 * @since 1.0.0
 */

/**
 * The address and port the server binds.
 *
 * @category models
 * @since 1.0.0
 */
export interface Bind {
  readonly hostname: string
  readonly port: number
}

/**
 * The default bind: loopback on the port the hosted OpenCode app expects.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultBind: Bind = { hostname: "127.0.0.1", port: 4096 }
```

Tests import `../src/<Module>.ts` and use `vitest` (`@effect/vitest` is available for `it.effect`).

### 1.5 `README.md`, `CHANGELOG.md`, `docs/`

- `README.md`: `# @smthrs/opencode` title, at least 120 prose characters, an `## Install` fence, a `## Modules` table with one row per barrel namespace. `check-docs` does not walk package READMEs; `DocsParity` does.
- `CHANGELOG.md`: `# @smthrs/opencode`, `## [Unreleased]`, `### Added`. The root `CHANGELOG.md` is generated (`//:changelog`), never hand-edited.
- `docs/README.md` and `docs/api.md`: frontmatter `title` and `description`, body headings start at `##`, no em or en dash outside fences, every fence names a language. `docs/api.md` is what `apps/site/scripts/sync-api-docs.mjs` stitches into `apps/site/src/content/docs/docs/reference/api/opencode.mdx` (see 2.4). Relative links `./x.md` become GitHub links until the package has a docs site.

### 1.6 Parent package edits (`packages/smithers`, the CLI)

The CLI's vitest root covers nested package directories, so add the child to both exclusion lists (CONTRIBUTING "Nesting another package" steps 7 and 8):

- `packages/smithers/vitest.config.ts`: `coverage.exclude` gets `"opencode/**"` (after `"notifications/**"`).
- `packages/smithers/dprint.json`: `excludes` gets `"opencode"` (after `"notifications"`).

## 2. Root and roster registration

### 2.1 No change

`pnpm-workspace.yaml` (`packages/smithers/*`), root `package.json` `workspaces`, root `tsconfig.json` (`packages/*/*/src/**/*` already covers it; `pnpm exec smthrs lint '//:tsconfig'` ran clean), `.github/workflows/ci.yml` (`//packages/...` patterns; `pnpm exec smthrs lint '//:ci'` ran clean).

### 2.2 Target index (must commit)

```bash
pnpm run target-index          # = smthrs target '//:targetIndex' --write
```

Probe: `//:targetIndex` lint failed with "the checked-in file drifted" until regenerated; the regenerated `.smithers/target-index.json` grew 309 lines for the package alone, 311 with the `apps/site/PACKAGE.ts` edit, 435 with the docs site. Commit the file. Regenerate last, after every other `PACKAGE.ts` edit.

### 2.3 Release roster (must edit)

- `scripts/pack-release.mjs`: add `"@smthrs/opencode",` to `publishedPackages` after `"@smthrs/observability",`. Without it `scripts/dev-compiler-isolation.test.mjs` fails with `unexpected: @smthrs/opencode` and `readWorkspaceManifests` throws.
- `scripts/pack-release.test.mjs` lines 209 and 216: the test title "exactly the 49 names" and `assert.equal(publishedPackages.length, 49)` become 50.
- `CONTRIBUTING.md` line 249: "the 49 names" becomes 50.
- `scripts/fixtures/public-export-surface.json` and its `baseline.packages.length === 47` pin need no change: the baseline suite only iterates packages already in the baseline.

The CLI publishes and will depend on the new package, so the package cannot be `private: true` (`never lets a published package depend on a private one`).

### 2.4 Site API reference (must regenerate)

`apps/site/scripts/sync-api-docs.mjs` discovers every public `@smthrs/*` package with `docs/api.md` and writes `apps/site/src/content/docs/docs/reference/api/<short>.mdx`; the `//apps/site:apiDocs` target lint-checks drift.

1. `apps/site/PACKAGE.ts`: add `import { Package as opencodePackage } from "../../packages/smithers/opencode/PACKAGE.ts"` after the gateway import (line 59) and `opencode: opencodePackage,` in `apiPackages` after `observability:` (line 224). This declares the page in the target's `changes`.
2. `node apps/site/scripts/sync-api-docs.mjs` writes `reference/api/opencode.mdx` (new) and `reference/api/cli.mdx` (the CLI page's "Related APIs" line gains the new dependency). It also rewrites `reference/api/control.mdx`, which is pre-existing drift on main; leave that file out of the commit or land it as its own fix.
3. Optional roster row: `apps/site/docs/reference/api/index.mdx` under "Control and wire", `| [`@smthrs/opencode`](/docs/reference/api/opencode/) | OpenCode protocol server over the Smithers agent loop, for the hosted OpenCode app |`, then `node apps/site/scripts/sync-support-docs.mjs` to project it into `src/content/docs/docs/reference/api/index.mdx`. `check-docs` rule 9 validates listed rows against manifests; it does not require every package to be listed.

`node apps/site/scripts/check-docs.mjs` ran 214 pages, 0 violations with the new package and 215 with its API page.

### 2.5 Docs site (recommended, 12 generated files, second lockfile importer)

`apps/docs/shared/AUTHORING.md` says every published package carries its own site; no gate enforces the row. If you add it:

1. `apps/docs/shared/manifest.mjs`: `["opencode", "@smthrs/opencode", "packages/smithers/opencode"],` after the gateway row.
2. `node apps/docs/shared/gen-sites.mjs` writes `apps/docs/opencode/{.gitignore,PACKAGE.ts,alchemy.run.ts,astro.config.mjs,package.json,tsconfig.json,public/favicon.png,src/content.config.ts,src/docs-assets/logo.png,src/styles/starlight.css}`.
3. `node apps/docs/shared/sync-content.mjs opencode` writes `apps/docs/opencode/src/content/docs/{index.md,reference/api.md}`.
4. `pnpm install --no-frozen-lockfile --ignore-scripts` again (new workspace member `@smithers/docs-opencode`): `pnpm-lock.yaml` grows another 22 lines, `bun.lock` another 16.
5. `pnpm run docs:check` (gen-sites and sync-content drift) ran clean.

### 2.6 Third-party notices, API baseline

`scripts/generate-third-party-notices.mjs` covers only the Rust crates behind `@smthrs/jj`; npm dependencies are outside its scope. `scripts/check-api-baseline.mjs` is not a CI gate. Neither needs a change for a package whose external deps are only `effect` and `@effect/platform-node`.

## 3. Lockfiles

### 3.1 pnpm

`pnpm install --frozen-lockfile --ignore-scripts` passes on main. After adding the package and the CLI dependency, `pnpm install --no-frozen-lockfile --ignore-scripts` (43 s) changes `pnpm-lock.yaml` in exactly two hunks, 94 insertions, 0 deletions:

- `@@ -2141` in the `packages/smithers` importer: three lines, `'@smthrs/opencode': specifier: 1.0.0-rc.0, version: link:opencode`.
- `@@ -5891`: the new `packages/smithers/opencode:` importer block (10 `link:` dependencies, 19 devDependencies, all already resolved elsewhere in the lockfile, so no new package entries).

No unrelated churn appeared. If a later run does show churn, keep only these two hunks: `jj diff --git -- pnpm-lock.yaml > /tmp/lock.diff`, delete the foreign hunks in the editor, `jj restore pnpm-lock.yaml`, `patch -p1 < /tmp/lock.diff`, then `pnpm install --frozen-lockfile --ignore-scripts` to prove the trimmed file resolves.

### 3.2 bun.lock (must refresh)

`//scripts:lockfileParity` compares every workspace manifest against `bun.lock`. The new package reddens it (`packages/smithers/opencode: absent from bun.lock workspaces`; `packages/smithers: dependencies @smthrs/opencode@1.0.0-rc.0 is absent`). Refresh:

```bash
bun install --lockfile-only --offline      # 0.6 s; node_modules stays in pnpm layout
node scripts/check-lockfile-parity.mjs     # "bun.lock agrees with all 113 workspace manifests"
```

The diff is 48 insertions, 0 deletions, and includes two pre-existing parity reds that main carries today: `apps/server` `zod@4.5.4` and `packages/rpc` `@smthrs/jj` and `@smthrs/crypto` as `workspace:*`. Landing the whole refresh turns the gate green; it is currently red on main. To land only the new hunks, edit the patch as in 3.1 (they are separate hunks), but then the gate stays red for the two old entries.

## 4. CLI verb `smithers opencode`

### 4.1 Facts

- Bin: `packages/smithers/package.json` `bin` maps both `smithers` and `smthrs` to `./bin/smithers.mjs`, which runs `src/bin.ts` in a checkout and `dist/esm/bin.js` when installed.
- Tree: `packages/smithers/src/Cli.ts` `makeCli` builds the Incur tree (`Cli.create` from `incur`, `z` from `incur`). Root verbs are `.command("<name>", { description, options, run })` entries; `serve` at lines 139 to 165 is the host precedent; `doctor` is the `Bridge.local` vs `Bridge.query` precedent.
- Options: `Bridge.connectionOptions` (`./cli/ControlBridge.ts`) is the shared `z.object` with `root`, `remote`, `credential`, `mcpConfig`, `quiet`; extend it with `options.extend({...})`. Incur turns camelCase keys into kebab flags (`olderThan` is `--older-than`, so `maxFrames` is `--max-frames`). Arrays are `z.array(z.string())` (see `migrate`'s `verifyTypecheck`).
- Handler shape: `run: (c) => Presentation.guard(c, async () => { ... })`. `Presentation.guard` renders the returned value as the document and maps thrown `CliError`s to exit codes: `UsageError` 2, `UnsupportedError` 1, `ResourceLimitError` 1, `RenderingError` 1; a control receipt decides 0, 1, 3 (parked), 130 (cancelled), 143. Non-zero exits from inside a handler go through `config.exit?.(code)` (see `doctor`, `gc`, `suggest`).
- Runners in `ControlBridge.ts`: `Bridge.local(effect, c.options, config)` provides `Project.layer`, `NodeControl.layerRegistry`, `NodeServices.layer` (no control host, no execution database); `Bridge.query` provides `NodeControl.layer` (local or `--remote` control plane); `Bridge.host(bind, c.options, config)` is `serve`'s blocking gateway host. A long-running server verb follows `serve`: `mcp: false` so it is not exposed as an MCP tool, refuse `--remote`, print a banner on stderr unless `--quiet`, run under `RedactedLogger.layer()` and `Logger.LogToStderr`, honour `config.signal`.
- `Globals.guard(globalsOf(c.options, config))` (`./commands/Globals.ts`) runs the 0.x notices and the unsupported-backend refusal; call it inside the effect before opening durable services.
- Command module: `packages/smithers/src/commands/OpenCode.ts` (engineering doc section 3). `commands/*` modules are not in the export map and need no `exports` key; the root `//:jsdocTree` gate still lints them.
- `Verb.ts` and `Command.ts`: leave alone. `Verb.shipped` pins only verbs that also have a legacy Effect CLI handler; `credentials`, `triggers`, `integrations`, `eval` are Incur-only today and have no `Verb.ts` row, no `Command.ts` handler, and no dedicated site page. `scripts/repo-contract/cli-verbs.test.mjs` only requires that every canonical command appear in the generated index table, which `gen-cli-data.mjs` produces.
- Flag naming: design doc section 7 says `--hostname`; the existing `serve` verb spells it `--host`. Follow section 7 (OpenCode's own `opencode serve` uses `--hostname`) and say so in the page. Section 7 also says loopback only unless `--listen`, so add `listen: z.boolean().default(false)` and reuse `Serve.loopbackHosts` and the `Serve.refuse` shape.

### 4.2 Sketch of the registration

```ts
// packages/smithers/src/Cli.ts, beside `serve`
.command("opencode", {
  description: "Serve the OpenCode protocol over the agent loop for the hosted OpenCode app",
  mcp: false,
  args: z.object({ directory: z.string().optional() }),
  options: options.extend({
    port: z.number().int().min(0).max(65535).default(4096),
    hostname: z.string().default("127.0.0.1"),
    listen: z.boolean().default(false),
    cors: z.array(z.string()).default([]),
    seat: z.string().optional(),
    maxFrames: z.number().int().positive().default(100)
  }),
  run: (c) =>
    Presentation.guard(c, () =>
      OpenCodeCmd.host({ ...c.options, directory: c.args.directory }, globalsOf(c.options, config), c.options, config))
})
```

### 4.3 Checklist for the verb

1. `packages/smithers/src/commands/OpenCode.ts`: new module with a module header, parse nothing (Incur did), build the layer stack, banner, run.
2. `packages/smithers/src/Cli.ts`: register the command (4.2); import `* as OpenCodeCmd from "./commands/OpenCode.ts"`.
3. `packages/smithers/package.json`: `"@smthrs/opencode": "1.0.0-rc.0"` in `dependencies` after `"@smthrs/notifications"`.
4. `packages/smithers/test/UnifiedRootCommands.test.ts`: add `"opencode"` to the inert-help list at line 130, `vi.mock("../src/commands/OpenCode.ts", ...)` beside the other command mocks, and one routing test in the `serve` style (lines 205 to 240) asserting the parsed flags reach the port and that `--remote` is refused.
5. `packages/smithers/test/Bin.test.ts` optional: one spawned-process case that `opencode --help` exits 0 (the `Bin` suite is the process-boundary oracle).
6. `packages/smithers/docs/README.md` line 85: add `opencode` to the "Host and integrate" row.
7. `packages/smithers/docs/reference/cli/README.md` line 31: add `opencode` to the `serve`, `doctor`, ... row. Leave the verb link list at lines 205 to 214 alone: `/cli/opencode` has no page until item 11 adds one, and a link to it is dead on the site.
8. `packages/smithers/README.md` commands table (line 62 region): add `opencode` to a row.
9. `packages/smithers/CHANGELOG.md`: `### Added` under `[Unreleased]`.
10. `node apps/site/scripts/gen-cli-data.mjs`: regenerates `apps/site/src/data/cli-commands.json`, `apps/site/src/data/help/opencode.txt`, the generated table in `apps/site/src/content/docs/docs/reference/cli/index.mdx`, and `smthrs.txt`. `//apps/site:cliData` lint-checks drift. The script runs `makeCli` in process, so the verb must parse with `--help` cleanly.
11. `apps/site/src/content/docs/docs/reference/cli/opencode.mdx`: optional page modeled on `serve.mdx` (frontmatter, `import help from "../../../../../data/help/opencode.txt?raw"`, Synopsis, Description, Flags table). Required only if the verb is later added to `Verb.ts`.
12. `node apps/site/scripts/check-docs.mjs`: the gate over `apps/site/src/content/docs/docs/**/*.mdx` (dashes, frontmatter, no body H1, absolute links only, anchors resolve, `@smthrs/*` imports in fences resolve to real subpaths, no "coming soon", publication roster rule 12). It no longer validates command names against the live CLI; `cli-verbs.test.mjs` and `//apps/site:cliData` do.
13. `pnpm --filter @smthrs/cli run check` and `pnpm --filter @smthrs/cli run test` (the CLI suite is long: `testTimeoutMs` 40 min in its `PACKAGE.ts`; run `vitest test/UnifiedRootCommands.test.ts test/Verb.test.ts test/Bin.test.ts` first).

## 5. Dependencies the server needs

Names and versions as they appear in sibling `package.json` files:

| Package | Path | Version | Where the CLI's `NativeControl.ts` uses it |
| --- | --- | --- | --- |
| `@smthrs/agent` | `packages/smithers/agent` | `1.0.0-rc.0` | `Agent`, `AgentAction`, `AgentSession`, `Budget`, `QuotaPolicy`, `StandardFlows`, `WorkspaceObservation` |
| `@smthrs/harness` | `packages/smithers/agent/harness` | `1.0.0-rc.0` | `QuickJSSandbox`, `Sandbox`, `Steering` |
| `@smthrs/model` | `packages/smithers/agent/model` | `1.0.0-rc.0` | `RequestExecutor` |
| `@smthrs/registry` | `packages/smithers/agent/registry` | `1.0.0-rc.0` | `Descriptor`, `Discovery`, `Executable`, `Registry` |
| `@smthrs/flow` | `packages/smithers/flows/flow` | `1.0.0-rc.0` | `Action`, `FlowRuntime` |
| `@smthrs/flows` | `packages/smithers/flows` | `1.0.0-rc.0` | `NodeRuntime` (type only in NativeControl; runtime in `NodeControlHost.ts`) |
| `@smthrs/engine` | `packages/smithers/flows/engine` | `1.0.0-rc.0` | not imported by NativeControl directly; `FlowEngine` comes through `@smthrs/flows` |
| `@smthrs/engine-store` | `packages/smithers/flows/engine-store` | `1.0.0-rc.0` | `ExecutionFacts`, `DurableEngineState`, `StepBoundary`, `WorkspaceSandbox` |
| `@smthrs/kernel` | `packages/smithers/flows/kernel` | `1.0.0-rc.0` | `ChildProcessSpawner`, `FileSystem`, `GrantStore`, `Jj`, `ProcessLedger`, `Workspace` |
| `@smthrs/capability` | `packages/smithers/flows/capability` | `1.0.0-rc.0` | `Capability`, `Permission` |
| `@effect/platform-node` | npm | `4.0.0-rc.115` | peer, exact; `NodeHttpServer`, `NodeServices` |
| `effect` | npm | `4.0.0-rc.115` | peer, exact; `effect/unstable/http` `HttpRouter` |

Also imported by NativeControl and likely needed once the server opens its own SQLite file: `@smthrs/database` (`DurableWriter`), `@smthrs/journal` (`SqlJournal`, `Journal`), `@smthrs/run-store` (`RunStore`, `Ownership`), `@smthrs/std` (`Checkpoints`, `Container`, `NativeSearch`), `@smthrs/platform-node` (`ProcessReaper`), `@smthrs/notifications`, `@smthrs/memory`, all `1.0.0-rc.0`, and `@effect/sql-sqlite-node` `4.0.0-rc.115` (the CLI declares it as a peer). Declare each one you import; the boundary gate fails on an undeclared import.

## 6. Verification

Package (all probe-verified green):

```bash
pnpm --filter @smthrs/opencode run format
pnpm --filter @smthrs/opencode run check      # 11 s
pnpm --filter @smthrs/opencode run lint       # eslint + dprint check
pnpm --filter @smthrs/opencode run circular
pnpm --filter @smthrs/opencode run test       # coverage thresholds 100
pnpm --filter @smthrs/opencode run build
pnpm exec smthrs ci '//packages/smithers/opencode/...'   # 7 targets: lib check test lint fmt docs circular
pnpm exec eslint --config eslint.config.js "packages/smithers/opencode/src/**/*.ts" --max-warnings=0   # what //:jsdocTree runs
```

Repo gates CI runs that a new package touches (`.github/workflows/ci.yml`, generated from root `PACKAGE.ts`):

| CI step | Command | Probe result |
| --- | --- | --- |
| Workspace targets | `pnpm exec smthrs ci '//packages/...' --jobs 2` | green for the package |
| Public export JSDoc | `pnpm exec smthrs lint '//:jsdocTree'` | green for the package |
| Script gates | `pnpm exec smthrs test '//scripts/...'` | see reds below |
| Generated workflow drift | `pnpm exec smthrs lint '//:ci'` | clean |
| Target index drift | `pnpm exec smthrs lint '//:targetIndex'` | drift until `pnpm run target-index` |
| Site | `pnpm exec smthrs ci '//apps/site/...'` (includes `apiDocs`, `cliData`, `docsLint` = `check-docs.mjs`) | run the scripts directly, see 6.1 |
| Package docs sites | `pnpm exec smthrs ci '//apps/docs/...'` | only if 2.5 is done |
| documentation parity | `smthrs docs '//packages/...'` | green (README parity) |

Direct script equivalents used in the probe:

```bash
node --test scripts/repo-contract/package-contract.test.mjs scripts/repo-contract/public-export-maps.test.mjs scripts/repo-contract/barrels.test.mjs
node --test scripts/dev-compiler-isolation.test.mjs scripts/build-release.test.mjs apps/site/scripts/catalog-publication.test.mjs
node --test --test-reporter=tap scripts/pack-release.test.mjs
node scripts/check-dependency-boundaries.mjs
node scripts/check-lockfile-parity.mjs
node apps/site/scripts/check-docs.mjs
node apps/site/scripts/sync-api-docs.mjs --check
node apps/docs/shared/gen-sites.mjs --check && node apps/docs/shared/sync-content.mjs --all --check
```

### 6.1 jj workspace limitation

`smthrs` Generate targets (`//apps/site:apiDocs`, `//apps/site:cliData`, `//apps/site:supportDocs`) fail inside a jj workspace with `git ls-files failed: workspace has no local .git; refusing ancestor repository discovery`. Run the generator scripts directly (2.4, 4.3 step 10) and let CI or the main checkout lint them. `smthrs ci` over packages, `//:tsconfig`, `//:ci`, and `//:targetIndex` work in the workspace.

### 6.2 Reds on main today (not caused by the new package)

- `node scripts/check-dependency-boundaries.mjs`: 3 findings (`packages/smithers/gateway/src/GatewayProjection.ts` and `src/internal/callEvents.ts` import undeclared `@smthrs/journal`; `apps/app/.../PlanLimits.test.ts` reaches into `apps/server/src`).
- `scripts/repo-contract/test-script-wiring.test.mjs`: "each suite needs a Smithers.testRunner entry or a reasoned unownedTests entry".
- `scripts/pack-release.test.mjs` tests 11 and 13 (ci.yml versus release.yml gate and toolchain parity).
- `node apps/site/scripts/sync-api-docs.mjs --check`: `reference/api/control.mdx` drifted.
- `node scripts/check-lockfile-parity.mjs`: `apps/server` zod and `packages/rpc` `@smthrs/crypto` absent from `bun.lock` (fixed as a side effect of 3.2).
- In the main checkout only, `smthrs lint '//:targetIndex'` fails with `module_import_failed` because an untracked `docs/reviews/2026-09-14-remediation/lanes/.../tree/scripts/repo-contract/PACKAGE.ts` is discovered; a clean workspace does not have it.

## 7. Landing recipe (explicit paths)

```bash
cd /Users/williamcory/smithers && jj workspace add ../smithers-opencode -r main && cd ../smithers-opencode
pnpm install --frozen-lockfile --ignore-scripts
# ... write packages/smithers/opencode/** (section 1), the parent edits (1.6), roster edits (2.3), site edits (2.4), CLI verb (4.3)
pnpm install --no-frozen-lockfile --ignore-scripts
bun install --lockfile-only --offline
pnpm --filter @smthrs/opencode run format
pnpm exec smthrs ci '//packages/smithers/opencode/...'
pnpm exec smthrs ci '//packages/smithers:check' '//packages/smithers:lint'
node apps/site/scripts/gen-cli-data.mjs && node apps/site/scripts/sync-api-docs.mjs && node apps/site/scripts/check-docs.mjs
pnpm run target-index
node scripts/check-lockfile-parity.mjs && node --test scripts/dev-compiler-isolation.test.mjs
jj git fetch && jj rebase -b @ -d main
jj commit -m "✨ feat(opencode): add @smthrs/opencode and the smithers opencode verb

<body>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" \
  packages/smithers/opencode \
  packages/smithers/package.json packages/smithers/vitest.config.ts packages/smithers/dprint.json \
  packages/smithers/src/Cli.ts packages/smithers/src/commands/OpenCode.ts \
  packages/smithers/test/UnifiedRootCommands.test.ts \
  packages/smithers/README.md packages/smithers/CHANGELOG.md packages/smithers/docs/README.md packages/smithers/docs/reference/cli/README.md \
  scripts/pack-release.mjs scripts/pack-release.test.mjs CONTRIBUTING.md \
  apps/site/PACKAGE.ts apps/site/src/content/docs/docs/reference/api/opencode.mdx apps/site/src/content/docs/docs/reference/api/cli.mdx \
  apps/site/src/data apps/site/src/content/docs/docs/reference/cli/index.mdx \
  .smithers/target-index.json pnpm-lock.yaml bun.lock
jj bookmark set main -r @- && jj git push -b main
cd /Users/williamcory/smithers && jj workspace forget smithers-opencode && rm -rf ../smithers-opencode
```

`jj diff --stat` shows `packages/smithers/opencode/dprint.json` as a rename of `packages/smithers/dprint.json` (`{ => opencode}/dprint.json`); it is a copy, and the explicit-path commit handles it. Add the docs-site files (2.5) to the same commit if you do that step.
