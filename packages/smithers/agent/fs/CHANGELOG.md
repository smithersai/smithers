# @smthrs/fs

## [Unreleased]

### Fixed

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
