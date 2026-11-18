# Changelog

## Unreleased

- Bun workspaces install. `S.Install` with `S.PackageManager.BunPackages`,
  `runInstall`, and the install Flow payload accept Bun, and `smthrs init`
  writes a Bun workspace for a `bun@` manifest. The fetch runs a frozen,
  script-free `bun install` in a staging copy under `.flows/store/bun`; the
  link runs `bun install --offline`. It needs Bun 1.4.1 or newer and a text
  `bun.lock`, and refuses `file:` and `link:` dependencies, unknown
  `bunfig.toml` install settings, and a root `.env` file that sets a `BUN_` or
  `NPM_CONFIG_` variable. `Install.Content` gains optional `bunfig` and
  `patches`, the store manifest gains a v3 tuple for them, and
  `PackageManager.bunInstallUnsupported` and `bunInstallUnsupportedMessage`
  are removed.
- With a forwarded `.npmrc` credential, `fetch` and `link` no longer put the
  operator's proxy URL, password included, on the pnpm command line, where every
  local user could read it. The proxy travels in the child environment, and
  `pnpm-workspace.yaml` proxy, TLS, and CA settings are refused with
  `unsafe_configuration`, as the `.npmrc` spellings already were.
- `S.nodeModules(directory)` declares an installed dependency tree as a target
  input. The directory's `package.json` and lockfiles key the target, and a
  confined tool may read its `node_modules`. A tool that resolves modules from
  a directory that is not above its own, such as a compiler test reading a
  sibling install, can now run inside the sandbox and publish to the shared
  cache. A directory with no manifest or no lockfile is refused.
- `affected` no longer selects audited confined native process targets or their
  Filegroup dependencies for unrelated package siblings. Unconfined and
  incomplete contracts remain conservative, including readable output mounts,
  custom workspace lockfiles and symbolic-link inputs. Confined tools no longer
  receive blanket read access to undeclared files in their declaring package.
- Runtime version requirements compare numeric prerelease identifiers exactly,
  including values beyond JavaScript's safe integer range. Adjacent large
  identifiers no longer admit an older runtime through rounding.
- Breaking: install linking declares `irreversible`, not `sealed`. The planner
  now accepts that honest tier. Link uses a run-local identity, never publishes
  shared cache, and does not promise rollback of ignored dependency files.
  It has no automatic retry or uncertain-attempt recovery contract. This
  changes link and downstream plan identities; finish existing runs before
  upgrading rather than mixing declarations within a run.

## 1.0.0-rc.0

- First public release candidate of the Smithers build runtime.
