# @smthrs/plugin

## [Unreleased]

### Added

- `PluginHost.query(name, params?)` takes `QueryParams`, named string values
  such as the repository a view is scoped to, and `ItemRef` carries the
  `params` its query was asked with, so a view selects a row of a query that
  takes them.
- `Host.Repository`, `Host.Rendered` and `Host.pathOf`: a `repository` view's
  path, `/<owner>/<name>/-/<plugin>/<path>`, and the repository its component
  receives. `PluginHost.open` takes the repository a `repository` view opens on.
- `Load.HostFacts.slash`: the host's own slash names; a plugin command naming
  one refuses `conflict`.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added the public typed plugin kernel, bounded host hook catalogs, stable
  ordering, configuration waterfalls, observer dispatch, and layer composition.
- Added complete `cacheEnvironment` identity for cross-run sealed reuse and a
  package-owned generated API contract.
- Added the optional plugin `version` field and folded selected `name@version`
  identities into every declared cache environment.
- Added stable runtime validation errors with value paths and published plugin,
  handler, preset, configuration, and parallel-concurrency bounds.

### Changed

- Configuration now contains only plugin-owned strict JSON namespaces. Removed
  the inert `engine`, `retry`, `store`, and `plugins` keys; runtime policy stays
  at the Effect service or constructor that applies it.
- Resolution now snapshots plugin records, hook entries, config, and cache
  identity before dispatch. The public handler catalog has no mutation methods.
- Parallel observers run at bounded concurrency, and first hooks refuse a
  non-`Option` result instead of silently skipping it.
- Declaring a cache environment now requires every selected plugin to provide a
  bounded non-empty version.

### Fixed

- Rejected prototype-control keys, accessors, exotic objects, sparse arrays,
  cycles, malformed runtime plugins, and inherited hook names. A proxy is read
  through descriptor reflection alone, so only the data its traps return is
  copied and no accessor or trap result can place behavior in an admitted value.
- Bounded the merged output of `Config.merge`, so two individually valid
  operands can no longer synthesize a config beyond the published byte, node,
  member, and depth limits for a later `config` handler to observe.
- Checked host-catalog hook names after `apply` selection again, so a shared
  preset carrying harness-only plugins resolves under a bare engine kernel.
  Plugin, option, and hook-entry shapes are still validated before selection,
  and the handler bound now counts the handlers the kernel dispatches rather
  than the handlers of plugins `apply` dropped.
- Prevented plugins that omit a prototype-named hook from registering the
  corresponding `Object.prototype` member as a handler.
- Kept plugin-built sealed keys run-local while complete capability identity is
  unknown and detached declared identity from later caller mutation.

### Breaking Changes

- Trimmed the published `engineHooks` catalog to the configuration lifecycle.
  Removed hook names no longer resolve through that constant.
- First hooks now refuse a non-`Option` result instead of silently skipping it.
- Removed the `Config.RetryConfig` and `Config.EngineConfig` schemas and their
  matching types. Both were root exports through `export * as Config`.
- Retyped `Config.FlowsConfig` and `Config.ResolvedConfig` from
  `Schema.StructWithRest` over an engine and retry struct to
  `Schema.Record(Schema.String, Schema.Json)`. Configuration that declared those
  policy keys now fails with `config_invalid`: `Kernel.make([], { engine: {} })`
  refuses at path `$.engine`.
- Narrowed `Config.merge` from `<A>(base: A, patch: unknown) => A` to
  `(base: FlowsConfig, patch: unknown) => FlowsConfig`, and `Config.deepFreeze`
  from `<A>(value: A) => A` to `<A extends ConfigValue>(value: A) => A`.
- Configuration refuses an `undefined` member instead of dropping it.
  `{ ns: { a: 1, b: undefined } }` fails `config_invalid` at path `$.ns.b`, and
  `Config.merge({ a: 1 }, { a: undefined })` now throws that error where it
  previously returned `{ a: 1 }`. Omit the key, or write `null`.
- Refuses a whitespace-only plugin `name` or `version`, and a declared hook
  entry whose value is `undefined`. All three previously resolved.
- Cache identity percent-escapes `%` and `@` in each `name@version` layer
  entry, so two compositions can no longer collide on one sealed identity.
  Existing sealed entries whose plugin names or versions contain either
  character change identity once.

## [0.1.0] - 2026-08-05

### Added

- Added the first Vite-style typed plugin prototype.
