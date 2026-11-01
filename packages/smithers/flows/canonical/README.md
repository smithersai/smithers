**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/canonical/docs

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.0` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

<!-- Deep reviewed and polished by a human. -->

# `@smthrs/canonical`

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/canonical/docs

RFC 8785 canonical JSON for TypeScript, as a plain function and as an Effect `Schema` codec. Two objects with the same entries in different key order, `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`, serialize to the same string, so their digests and their cache keys match.

## Install

```bash
npm install @smthrs/canonical@next effect
```

`effect` is a peer dependency at exactly `4.1.0`. Node.js 22.19.0 or later. Ships as ESM and CommonJS with TypeScript declarations.

## Use it

```typescript
import { Canonical, canonicalize } from "@smthrs/canonical"
import { Schema } from "effect"

canonicalize({ b: 2, a: 1 })
// '{"a":1,"b":2}'

Schema.decodeUnknownSync(Canonical)({ b: 2, a: 1 })
// '{"a":1,"b":2}', branded so a plain string cannot pass for a canonical document
```

`canonicalize` follows `JSON.stringify` for JSON data, `toJSON(key)`, boxed primitives, and sparse arrays, then sorts keys by UTF-16 code units. It rejects non-finite numbers, BigInt, lone surrogates, cycles, digest-unsafe non-plain built-ins, and nesting beyond 10,000 levels. Failures are `CanonicalError` values with stable `code` and `path` fields.

Canonical output is digest-critical: changing its bytes changes every downstream digest.

Wire contracts and hosts that do not use Effect can import `canonicalize` and `CanonicalError` from
`@smthrs/canonical/Serializer`. This runtime-free entry shares the exact implementation exported by the package root;
it does not load the schema or change canonical bytes.

`isRecord` is the shared array-excluding object guard, available from the package root and `@smthrs/canonical/Record`. It checks shape without reading members; it is not a plain-object or JSON validator.

`BoundedJson`, also available from `@smthrs/canonical/BoundedJson`, admits untrusted JSON through own data descriptors without invoking getters or `toJSON`; a Proxy's inspection traps still run, so pass parsed or otherwise inert data. It returns a detached, deeply frozen snapshot and its encoded byte count, or a refusal with a field path. Callers supply depth, node, and per-container member limits; byte, string, key, and cumulative member limits are optional. Flow, cache, and run persistence share this traversal while retaining their own limits and diagnostic presentation. `admitStrict` also rejects hidden members, repeated references, reserved keys, and nonordinary arrays; its member budget is cumulative and its depth budget counts containers. Filesystem and plugin boundaries use this shared traversal. It can retain ordinary record prototypes, identify malformed or oversized keys by position, and index detached containers in postorder for incremental merges. Other diagnostic paths still contain input keys. Both admission forms use an explicit stack, so configured depths are independent of the JavaScript call stack. This admission API does not change `canonicalize` or the bytes it emits.

The serialization contract, every failure code, and the guide to converting a value the serializer refuses are at https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/canonical/docs.

`@smthrs/canonical/ReadonlyMap` provides `make`, a frozen read-only map facade over copied entries; keys and values are not deep-frozen. `@smthrs/canonical/IssuePath` provides `firstPath`, which locates the first Effect schema issue without rendering the rejected value. Neither helper is exported from the package root. The [API reference](./docs/api.md) covers these helpers, strict admission options, and the legacy serializer policy.
