# @smthrs/fs

## [Unreleased]

### Added

- `Incur.Host` is a service with a default value that supplies the command
  line, the `COMPLETE` environment variable, standard output, and process
  exit to a served CLI. `@smthrs/fs` no longer reads `process` itself: without
  a provided host it uses the ambient `process` when the runtime has one and
  an inert host when it does not, so `serve` no longer throws
  `ReferenceError` where `process` is undefined.
- `FileRouter.scan` runs through the registry's `Discovery` service when one
  is provided.

### Fixed

- A bare boolean flag in a command string no longer takes the next token as
  its value: `deploy --force prod` assembles `{ force: true, args: ["prod"] }`
  instead of `{ force: "prod" }`. `--force=false` and `--no-force` still spell
  `false`.
- A first argv token that begins with `-` is no longer split on slashes, so
  `cli --config=/etc/app.json deploy` reaches the parser as written. The
  command surface and the Incur CLI share one implementation of that rule.

- `Route.snapshot` reads an `Option`'s tag and payload as data properties, so
  an accessor inside `description`, `placement`, or `ui` fails with
  `invalid_route` instead of running.
- `FlowInvoker.make`, `makeNoop`, and `layerNoop` throw `TypeError` for an
  implementation whose `invoke` is missing, inherited, an accessor, or not
  a function, and for an invalid supplied override, as documented.

## [0.1.0] - 2026-09-01

### Added

- Added private metadata-only discovery for module, Markdown, and skill routes.
- Added bounded immutable route trees, direct command projection, an Incur CLI
  projection, and an injected `FlowInvoker` execution boundary.
- Added schema-derived argument descriptors with authoritative Effect decoding
  and encoding around every invocation.
- Added package-owned generated documentation and ESM/CJS artifact contracts.

### Changed

- Pinned `incur` to `0.4.19`, the version actually resolved by the workspace.
- Limited execution surfaces to explicitly model-invocable module routes;
  Markdown and skill routes remain metadata only.

### Security

- Added bounded snapshots for routes, commands, schemas, inputs, and outputs.
- Sanitized typed failures so raw arguments, values, and implementation causes
  do not cross the adapter boundary.
