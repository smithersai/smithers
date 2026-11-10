---
"@smthrs/canonical": patch
"@smthrs/flow": patch
"@smthrs/engine": patch
"@smthrs/engine-store": patch
---

VIP-44 review fixes. `Flow.payloadPreimage` tags a collection payload's preimage as `["snapshot", …]`, so a set can no longer share a child id with an array written as the set's snapshot; both identity functions are lazy, and the recorded plan's root input is encoded only when a plan is recorded. A retry-carried child derives its id from the same preimage. engine-store runs every action under the serializer it accepted and exposes it to dispatch. Dispatch applies the JSON `undefined`-to-`null` normalization only to JSON-codec results. `sortCollections` never throws on a revoked callable proxy. Uses the library catalog's `@smthrs/flow` and `@smthrs/canonical` entries.
