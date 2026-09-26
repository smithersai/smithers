# @smthrs/crypto

## Unreleased

### Fixed

- Share live function identity metadata across compatible bundles without reading entropy at module initialization. ([#1991](https://github.com/smithersai/smithers/issues/1991)).

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added typed injected hashing through `digest`, explicit synchronous hashing
  through `digestSync`, the public `Digest` schema, and the compatibility
  `Sha256` transformation.
- Added stable, cause-preserving `Sha256Error` codes and package-owned API
  documentation.

### Changed

- Reject unpaired UTF-16 surrogates instead of accepting `TextEncoder`
  replacement collisions.
- Snapshot caller bytes before crossing an asynchronous host boundary and copy
  host digest bytes before encoding.
- Consolidate the repository's handwritten synchronous SHA-256 implementation
  here and reject non-SHA-256 algorithms in `syncCrypto`.
- Redact hash inputs from schema diagnostics and validate that hosts return
  exactly 32 digest bytes.
