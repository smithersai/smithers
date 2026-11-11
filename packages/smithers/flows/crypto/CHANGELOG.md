# @smthrs/crypto

## Unreleased

### Added

- `digestStream`: SHA-256 of a byte stream with the package-owned
  implementation, holding only the current chunk, so the input may exceed any
  host buffer. It requires no Effect service.
  ([#4754](https://github.com/smithersai/smithers/issues/4754)).

- `WebCrypto.make()` and `WebCrypto.layer`: Effect's `Crypto` over the global
  WebCrypto, for Node, Bun, browsers and Cloudflare Workers. `randomBytes`
  fills in chunks of at most 65,536 bytes and reads randomness only on demand.
  It replaces the copies in `@smthrs/platform-cloudflare` and
  `@smthrs/platform-node`.

### Fixed

- Keep callbacks reading implicit `arguments` or common host globals distinct during resume; correct the digest-service documentation and API-reference checks. ([#4488](https://github.com/smithersai/smithers/issues/4488)).

- `Uuid.v5` rejects unpaired UTF-16 surrogates instead of assigning distinct
  malformed names the same UUID, and rejects malformed SHA-1 host digests.
  UUIDs for well-formed names remain unchanged. ([#4487](https://github.com/smithersai/smithers/issues/4487)).

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
