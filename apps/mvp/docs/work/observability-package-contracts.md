---
title: Observability package contracts
status: done
area: sdk
owner: Codex
updated: 2026-11-13
links: ["https://github.com/smithersai/smithers/issues/4617"]
---

Expose `OtlpRelay` through the package's existing subpath convention. Verify
development resolution and published ESM and CommonJS module identity.
Correct the source documentation and generated API reference. Move journal
snapshot security checks to their owning package and cover the relay, export
redaction, logger sinks and failure labels. Replace placeholder assertions with
resource, sink and real-collector checks.


Validated with the full observability suite (255 tests and 100% coverage),
package typecheck and lint, the public export-map contracts, documentation
sync and tarball checks, and the generated target-index check.
