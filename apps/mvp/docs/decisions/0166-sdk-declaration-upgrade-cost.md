# 0166 — Review the SDK declarations after the dependency upgrade

Date: 2026-11-09. Status: accepted declaration snapshot.

## Authority and comparison

The accepted dependency-upgrade API ruling of 2026-11-04 distinguishes two
changes: the Effect upgrade is its own change, with its declaration diff listed
as upgrade cost; the VibeLang migration's API-identity bar compares against
main plus that upgrade at a named revision. This applies the unchanged
[package API rule](../rulings.md) and
[release compatibility policy](../../../../RELEASE_SUPPORT.md#reviewing-changes-before-publication).

The previous recorded baseline is
`a3525ec76935aa35ef344b86665e07eb9d7b4c2f`.
The reviewed current tree is
`0643f98e4e661db8a52e261637386832df563dce`.
The dependency update begins at
`91509fbc4aa28c17ecebbd8e69eea4a87ef1c1ba`:
Effect `4.1.1`, VibeLang `0.0.12` and Alchemy `2.0.0-beta.85`.
The service and host adaptations are part of that upgrade, rather than
declaration-neutral language conversions.

## Why publication refused

The landing projection calls
`node .smithers/flows/release/check-api-baseline.mjs --build-declarations`.
It compares every public package's publication exports and emitted declaration
hashes with `.smithers/flows/release/fixtures/public-api-baseline.json`.
Private declarations are included because public signatures may refer to them.

The untouched current tree refuses with 43 changed packages out of 52.
There are 565 changed declaration files, including repeated private adapter
copies. The checker is byte-for-byte unchanged since the previous baseline.
The declarations had advanced without their reviewed snapshot.

## Compatibility impact

The dependency update changes inferred Effect Schema declarations and service
requirements. Digest, randomness, HTTP client, filesystem and SQL services must
be provided according to the new signatures. Schema error classes use their
documented factories. These are upgrade costs; they are not evidence that a
VibeLang conversion preserved the previous dependency family's API.

The private Node and Bun adapters follow the same Effect family. The WebSocket
declarations newly retained by `58211db0f2d5` repair incomplete private adapter
output; they are not new public package subpaths.

Subsequent intentional features are recorded separately in the inventory:
GitHub issue/proposal, device sign-in and delegation APIs; native Bun desktop
host services; harness workerd helpers; registry bundled-module helpers; engine
step diagnostics; and `@smthrs/fuzz` with its testing integration. Their source
revisions identify the existing additions being recorded. They are not charged
to the dependency upgrade.

## Review evidence

The inventory below names every changed declaration file and changed
top-level or namespace declaration, with the source revisions that changed its
module or dependency pin. The accompanying declaration diff records
before/after changes, including imports, documentation, private declarations
and export maps. Source revisions are provenance, rather than a claim that each
intermediate source revision independently built.

The baseline is regenerated only by its owning command after reviewing this
inventory. The gate, canonicalization, package roster and compiler selection
remain unchanged.


The historical tree was rebuilt with its original frozen dependencies; all
recorded hashes matched. The current tree was rebuilt independently with its
own frozen dependencies. Both the direct gate assertion and the exact landing
command refused the previous baseline.

One unintended change was found: VibeLang's newer emission made
`SmithersErrorOptions.cause` and `SmithersErrorOptions.includeDocsUrl` mutable,
although the older baseline exposed them as readonly. Their source interface
did not state the modifiers explicitly. The dependency pin in
`91509fbc4aa2` changed the emitter. Explicit `readonly` modifiers restore that
contract; a consumer typecheck tests both forbidden assignments. That
restoration is a separate source fix, not an accepted upgrade cost.


## Package changes

| Package | Difference from the previous baseline |
| --- | --- |
| `@smthrs/agent` | `Digest`/random service requirements replace `Crypto`; `Schema`-derived and helper types follow the new emitter. |
| `@smthrs/artifacts` | `Digest` service requirements replace `Crypto` in storage and byte measurement. |
| `@smthrs/build` | Install and package-manager hashing require `Digest`. |
| `@smthrs/build-cli` | Install-layer inference follows the upgraded host adapters; private adapter declarations change with the dependency family. |
| `@smthrs/capability` | Permission errors replace custom constructors with documented static factories; `Schema` base types follow Effect 4.1. |
| `@smthrs/cli` | Node/Bun host composition exposes `Digest`/random requirements; store and runner inference and private adapter declarations follow Effect 4.1. |
| `@smthrs/control` | `Digest` requirements and RPC/schema inference change; `RequestScheme` follows the upgraded `Context` reference shape. |
| `@smthrs/core` | `Digest` replaces `Crypto`; `Placement` uses the new `Schema` declaration shape. |
| `@smthrs/crypto` | `Digest` and `SecureRandom` replace `Crypto`; synchronous digest and `WebCrypto` layers expose their new host contracts. |
| `@smthrs/database` | Adds `registerReadTransaction` for drivers whose transaction boundary is supplied by the host. |
| `@smthrs/engine` | `Digest`/random requirements change; adds the existing `StepTrace` diagnostic API and its dispatcher integration. |
| `@smthrs/engine-store` | `Digest`/random requirements and `Schema` inference change; transaction helper types refer to the host-aware `Dialect` API. |
| `@smthrs/errors` | Import suffixes and throws annotations follow VibeLang. Two lost readonly modifiers are restored separately rather than accepted. |
| `@smthrs/flow` | `Digest`/random requirements replace `Crypto` across actions, identities, clocks, queues, flows and interpreter; helper/schema inference changes. |
| `@smthrs/flows` | Runtime host composition exposes the upgraded service requirements. |
| `@smthrs/fuzz` | Records the new public fuzz package, its generators, corpus and simulation declarations, and the subsequent corpus-engine correction. |
| `@smthrs/gateway` | RPC and projection schemas follow Effect 4.1 inference; private adapters follow the new dependency family. |
| `@smthrs/harness` | `Schema` and alias inference changes; adds workerd/Wasm helpers and records the rebuilt opaque realm bundle. |
| `@smthrs/integrations` | Adds cookie-key, GitHub authentication/broker/delegation and issue/proposal APIs; `Source` requirements and `Schema` inference follow Effect 4.1. |
| `@smthrs/journal` | Serialized fact/event `Schema` declarations use Effect 4.1 inferred types. |
| `@smthrs/kernel` | Child-process environment values use protected `Redacted` arguments and the upgraded execution renderer. |
| `@smthrs/keys` | Key derivation requires `Digest` and follows the new tagged-error declaration shape. |
| `@smthrs/memory` | Memory services require `SecureRandom`; test composition also exposes `Digest`. |
| `@smthrs/migrate` | Records Effect 4.1.1 version literals, `Digest`/random host requirements and private adapter changes. |
| `@smthrs/model` | `Schema`-derived JSON, model-event, request and provider types follow Effect 4.1; alias inference follows VibeLang. |
| `@smthrs/notifications` | Notification/event `Schema` declarations use the upgraded JSON/schema types. |
| `@smthrs/plan` | `Digest` replaces `Crypto` in identities and verification; `Schema`/key-material inference and representation identity declarations change. |
| `@smthrs/plan-store` | Plan-store constructors require `Digest` instead of `Crypto`. |
| `@smthrs/platform-browser` | Browser engine hosts provide `Digest` and `SecureRandom`; protocol `Schema` inference changes. |
| `@smthrs/platform-bun` | Adds native desktop, server and file-replacement APIs; host requirements and private adapters follow Effect 4.1. |
| `@smthrs/platform-cloudflare` | Adds `ObjectDatabase` and retention helpers/options; host composition requires the new crypto services. |
| `@smthrs/platform-node` | Host requirements and private adapters follow Effect 4.1; adds `sqliteObjectStorage` and related test-host composition. |
| `@smthrs/plugin` | Manifest/config `Schema` inference follows Effect 4.1 JSON schemas. |
| `@smthrs/registry` | Adds `Bundled` catalog helpers; executable/key-material declarations and `Digest` requirements follow their source revisions. |
| `@smthrs/sandbox` | The newer emitter preserves callable aliases and named private helpers in sandbox session/command types. |
| `@smthrs/scorers` | The newer emitter preserves the rubric callable alias instead of expanding it. |
| `@smthrs/std` | The newer emitter preserves `effectsFor` callable aliases and names private `GitWorktree` helpers; public call signatures remain represented by those source functions. |
| `@smthrs/sync` | Sync protocol/RPC `Schema` declarations follow Effect 4.1 inference. |
| `@smthrs/targets` | The newer emitter preserves aliases and updated `Schema` inference in build-tool and factory declarations. |
| `@smthrs/testing` | Adds fuzz registration, corpus and simulation APIs; engine-like layers expose `Digest`/random requirements. |
| `@smthrs/time-travel` | Preserves the workspace-name callable alias and adopts Effect 4.1 migration/JSON schema types. |
| `@smthrs/triggers` | Trigger `Schema` inference follows Effect 4.1. |
| `@smthrs/views` | The newer emitter preserves the private byte-counter binding through its harness alias. |

The per-file inventory and revision ledger below give the exact symbols and
source revisions for each entry. Callable aliases are emission differences;
this record does not charge subsequent feature additions to the dependency upgrade.

## Later accepted API recorded before publication

The initial refusal above remains a comparison of the original 43 packages
and 565 declaration files. The subsequent accepted VIP-44 addition in
`f4b973ab278909c7a41a0fb273c92d7036cc4493` adds
`sortCollections` to `@smthrs/canonical`. The refresh also records that
separate intentional API against
`e119afb8dd329cabfe250cbdb768fa465ab2d2e2`.
It is not a dependency-upgrade cost.

The additional `@smthrs/canonical` changes are:
`index.d.ts` re-exports `sortCollections`;
`sortCollections.d.ts` declares `sortCollections: <A>(value: A) => A`;
and the publication export map adds `./sortCollections` for both ESM and
CommonJS, with the corresponding declaration and JavaScript paths.
The [additional declaration diff](sdk-declaration-upgrade-cost/declarations-06.diff)
records every line, including the documentation.

That intermediate snapshot changes 44 packages and 567
declaration files relative to the old baseline. The other 42 package entries,
including the restored readonly options, are byte-for-byte unchanged from the
reviewed candidate. The package roster and checker are unchanged.
The follow-up `e119afb8dd32` uses the sorter for derived execution identity
without changing that package's emitted declarations. The deferred-not-found
repair in `53466ad8a7df` adds `{ readonly _tag: "NotFound" }` to
`DurableEngineState.CompleteDeferredOutcome` and documents that an unknown
execution stores no completion. This intended correction is a separate API
change, not an upgrade cost. Its [declaration diff](sdk-declaration-upgrade-cost/declarations-07.diff)
records the added outcome and documentation; its publication exports are
unchanged.

## Later shared payload identity

Accepted VIP-44 commit `bcf8076a4ff4` adds the shared payload identity
functions under the existing `Flow` API. This is a further intentional API
addition, not a dependency-upgrade cost.

- `Flow/PayloadIdentity.d.ts` adds `payloadSnapshot<S extends Schema.Top>`,
  returning `Effect.Effect<Schema.Json, Schema.SchemaError, S["EncodingServices"]>`,
  and `payloadPreimage<S extends Schema.Top>`, returning
  `Effect.Effect<unknown, Schema.SchemaError, S["EncodingServices"]>`.
  Both take `(schema: S, value: unknown)`.
- `Flow/index.d.ts` re-exports `./PayloadIdentity.ts`; the publication export
  map is unchanged.
- `@smthrs/platform-cloudflare` `ExecutionObject.d.ts` changes `Flow`
  from a type-only import to a value import and documents the shared identity
  snapshot in `initialIntent`. Its callable declarations and publication
  exports are unchanged.

The [additional declaration diff](sdk-declaration-upgrade-cost/declarations-08.diff)
lists every changed line. The captured text matches all three official
declaration hashes. The owning declaration builder, official updater and
baseline check pass for this snapshot. Compared with the original historical
baseline, that intermediate snapshot changes 44 packages and 569 declaration files;
the unchanged checker still covers all 52 public packages.

## Final serialization and durable-payload declarations

The final snapshot reviews published main
`b5f6b215e95c667087b3bdfb7f18c1fc1941525a` plus the separate readonly and stored-schema type repairs.
The additional accepted VIP-44 work remains separate from the dependency
upgrade cost.

`Action.exitSchemasFor` and `ExitSchemas<Success, Error>` preserve decoded
success/error types and both schema service channels; their encoded holes are
`unknown`, as Effect's `RpcSerialization.CodecFor` contract requires.
`Action.StoredSerialization` is a context reference with the JSON serializer
as its default. An engine provides it for stored results without changing the
RPC serializer visible to an action body.

`FlowEngine.Encoded.serialization` selects the stored codec. The store exposes
`UnstorableSerialization`, whose `code` is `"unstorable_serialization"` and
whose `contentType` identifies a codec its current JSON-value storage cannot
hold. `Flow.payloadPreimage` documents its tagged snapshot form, keeping a
collection snapshot distinct from a collection-free payload. `Skills.InstallPayload`
contains only library, agents and selection data; target dependencies remain
in the build graph and are removed from `InstallAction`'s durable payload.

The serialization implementation in `151fbdf1d3ab` unintentionally widened
the published `Dispatch.makeActionExecute` result and service requirements to
`any`. This snapshot records the repaired declarations, not that type loss.
Its result again contains `Flow.Complete<Success["Type"], Error["Type"]>`
and its requirements include the actual schema decoding services. Consumer
typechecks fail on the original source and pass after the generic cache repair;
the runtime cache algorithm is unchanged. The four JSON serializers and swapped
schema pairs have property coverage, and both SDK package checks pass.

The [additional declaration diff](sdk-declaration-upgrade-cost/declarations-09.diff)
lists every changed line relative to the preceding snapshot.
Context is omitted for `Skills.d.ts`; all of its changed lines are included.

| Package | Declaration file | Changed declarations, bindings or documentation | Source |
| --- | --- | --- | --- |
| `@smthrs/engine` | `FlowEngine/Dispatch.d.ts` | `import Cause`, `import Exit`, `import Option`, `import Result`, `makeActionExecute` | `151fbdf1d3ab`; restored generic types in the separate source repair |
| `@smthrs/engine` | `FlowEngine/Encoded.d.ts` | `module documentation`, `import RpcSerialization`, `Encoded.serialization` | `151fbdf1d3ab` |
| `@smthrs/engine-store` | `EngineStore.d.ts` | `import Cause`, `import Schema`, `UnstorableSerialization_base`, `UnstorableSerialization` | `151fbdf1d3ab` |
| `@smthrs/engine-store` | `Errors.d.ts` | `export UnstorableSerialization` | `151fbdf1d3ab` |
| `@smthrs/flow` | `Action/Context.d.ts` | `import RpcSerialization`, `StoredSerialization` | `975ed2b04f4c` |
| `@smthrs/flow` | `Action/make.d.ts` | `import RpcSerialization`, `StoredCodec`, `ExitSchemas`, `exitSchemasFor` | `151fbdf1d3ab`; restored generic types in the separate source repair |
| `@smthrs/flow` | `Flow/PayloadIdentity.d.ts` | `payloadPreimage` | `72bc14c0e851` |
| `@smthrs/targets` | `Skills.d.ts` | `InstallAction`, `InstallPayload` | `6e6148b53f36` |

The complete old-baseline comparison is **44 packages and 573
declaration files**. The original 43-package, 565-file refusal and every
intermediate addition remain individually attributable above. The owning
declaration builder, official baseline updater and check pass for all 52
public packages. The checker, canonicalization and compiler selection are
unchanged.

## Declaration inventory

The inventory lists all 43 packages and every one of the 565 changed declaration
files from the initial refusal. `import` and `export` entries identify changed
bindings; the other entries identify declarations, including private helpers.
The [declaration diff 1](sdk-declaration-upgrade-cost/declarations-01.diff), [declaration diff 2](sdk-declaration-upgrade-cost/declarations-02.diff), [declaration diff 3](sdk-declaration-upgrade-cost/declarations-03.diff), [declaration diff 4](sdk-declaration-upgrade-cost/declarations-04.diff), [declaration diff 5](sdk-declaration-upgrade-cost/declarations-05.diff)
contains the textual changes and export-map differences. The generated realm
source literal is identified by its before/after declaration hashes rather than
embedding the generated program. Repeated adapter
diffs appear once with all owning packages named.

The readonly option modifiers shown as removed in the initial diff are restored
before accepting the final baseline. The baseline therefore does not accept
that unintended change.

### `@smthrs/agent`

- `AgentAction.d.ts`: `import "effect/Crypto"`, `AgentAction`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `AgentSession.d.ts`: `import "@smthrs/capability/Capability"`, `import "effect/Crypto"`, `Services`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Digest"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `ChildFlows.d.ts`: `SpawnInput`, `spawnFlow`. Source revisions: `91509fbc4aa2`.
- `EngineChildren.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `ExternalAgent.d.ts`: `make`. Source revisions: `91509fbc4aa2`.
- `FlowEngineLike.d.ts`: `import "effect/Crypto"`, `sandboxed`, `make`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `InMemoryWorkspaceSandbox.d.ts`: `make`. Source revisions: `91509fbc4aa2`.
- `ModelStep.d.ts`: `import "effect/Crypto"`, `run`, `Requirements`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `SeatResolver.d.ts`: `contextWindowTokensFor`, `import "@smthrs/model/ModelCatalog"`. Source revisions: `91509fbc4aa2`.
- `SeatRouter.d.ts`: `DecisionSchema`. Source revisions: `91509fbc4aa2`.
- `StandardFlows.d.ts`: `import "effect/Crypto"`, `JevInput`, `jevFlow`, `clock`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `internal/ModelStep.d.ts`: `import "effect/Crypto"`, `RecordedModelStep`, `dispatch`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.
- `internal/StepTrace.d.ts`: `import "effect/Crypto"`, `make`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `c7defaa87e49`, `91509fbc4aa2`.

### `@smthrs/artifacts`

- `ArtifactStore.d.ts`: `import "effect/Crypto"`, `Service`, `import "effect/crypto/Digest"`. Source revisions: `a9e180e22a59`, `91509fbc4aa2`.
- `measureBytes.d.ts`: `import "effect/Crypto"`, `measureBytes`, `import "effect/crypto/Digest"`. Source revisions: `a9e180e22a59`, `91509fbc4aa2`.

### `@smthrs/build`

- `Install.d.ts`: `import "effect/Crypto"`, `executeMeasure`, `MeasureLive`, `executeFetch`, `FetchPnpmLive`, `executeLink`, `LinkLive`, `layer`, `import "effect/crypto/Digest"`. Source revisions: `1d79c56e0ce0`, `91509fbc4aa2`.
- `PackageManager.d.ts`: `import "effect/Crypto"`, `Service`, `storeManifest`, `linkedTreeManifest`, `npmrcDigest`, `lockfileDigest`, `packageJsonDigest`, `import "effect/crypto/Digest"`. Source revisions: `1d79c56e0ce0`, `91509fbc4aa2`.

### `@smthrs/build-cli`

- `engine.d.ts`: `layerNonInteractiveNodeServices`, `layerInstall`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`, `8f19d24637dc`.
- `../vendor/cjs/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `import "ws"`, `export { NodeWS }`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `export "ws"`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeWS.d.ts`: `export "../../ws.mjs"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/NodeWS.d.ts`: `export "ws"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.

### `@smthrs/capability`

- `PermissionDenied.d.ts`: `PermissionDenied`. Source revisions: `1729e9add541`, `91509fbc4aa2`.
- `PermissionRequired.d.ts`: `PermissionRequired_base`, `PermissionRequired`. Source revisions: `1729e9add541`, `91509fbc4aa2`.

### `@smthrs/cli`

- `NodeControl.d.ts`: `layerHostPlatform`, `layerGuardedPlatform`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `Serve.d.ts`: `host`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `5c921cecd412`, `91509fbc4aa2`.
- `internal/BunControl.d.ts`: `native`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `internal/HealthHost.d.ts`: `import "effect"`, `watch`, `start`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `1097de48fdd4`, `00ae32d262f3`, `02e51b6c7ba7`, `5c921cecd412`, `91509fbc4aa2`.
- `internal/ModuleAuthority.d.ts`: `make`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `internal/NativeControl.d.ts`: `import "effect"`, `Platform`, `make`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `1097de48fdd4`, `00ae32d262f3`, `02e51b6c7ba7`, `5c921cecd412`, `91509fbc4aa2`.
- `internal/NativeControlDatabase.d.ts`: `StoreInitializing`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `5c921cecd412`, `91509fbc4aa2`.
- `internal/NodeControlHost.d.ts`: `native`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `internal/SupervisorMemory.d.ts`: `import "effect/Crypto"`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `1097de48fdd4`, `00ae32d262f3`, `02e51b6c7ba7`, `5c921cecd412`, `91509fbc4aa2`.
- `operator/Store.d.ts`: `databaseLayer`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `operator/TriggerPlans.d.ts`: `stored`, `StandingApproval`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `runner/Serve.d.ts`: `loop`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `suggest/SuggestFlow.d.ts`: `layer`, `layerNode`, `layerScripted`, `run`. Source revisions: `1097de48fdd4`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `../vendor/bun/BunCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunHttpClient.d.ts`: `export "effect/http/FetchHttpClient"`, `import "effect/http/HttpClient"`, `import "effect/Layer"`, `Options`, `layerOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunHttpServer.d.ts`: `import "bun"`, `make`, `layer`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunRedis.d.ts`: `import "bun"`, `layer`, `layerConfig`, `BunRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `BunServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunHttpClient.d.ts`: `export "effect/http/FetchHttpClient"`, `import "effect/http/HttpClient"`, `import "effect/Layer"`, `Options`, `layerOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunHttpServer.d.ts`: `import "bun"`, `make`, `layer`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunRedis.d.ts`: `import "bun"`, `layer`, `layerConfig`, `BunRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `BunServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `import "ws"`, `export { NodeWS }`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `export "ws"`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeWS.d.ts`: `export "../../ws.mjs"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/NodeWS.d.ts`: `export "ws"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.

### `@smthrs/control`

- `ControlFacts.d.ts`: `RunFact`. Source revisions: `91509fbc4aa2`.
- `ControlRpcs.d.ts`: `ControlDefect`, `ControlRpcs`. Source revisions: `91509fbc4aa2`.
- `ControlRuntime.d.ts`: `import "effect"`, `layerMemory`, `import "effect/crypto/Digest"`. Source revisions: `5c9d26ffffef`, `91509fbc4aa2`.
- `ControlSchema.d.ts`: `PlanNode`, `PlanCard`, `PendingWait`, `RunSummary`, `SignalPayload`, `PlanInputSchema`, `SignalInputSchema`, `ControlEvent`, `TriggerSummary`, `PlanSummary`, `ExecutionBatch`, `ListRequest`, `ListResponse`. Source revisions: `91509fbc4aa2`.
- `ControlServer.d.ts`: `RequestScheme`. Source revisions: `80307dada4f9`, `91509fbc4aa2`.
- `SqlControlRuntime.d.ts`: `import "effect"`, `makeRuntime`, `layer`, `layerWithStore`, `import "effect/crypto/Digest"`. Source revisions: `5c9d26ffffef`, `91509fbc4aa2`.
- `internal/planning.d.ts`: `digest`, `planCard`. Source revisions: `91509fbc4aa2`.

### `@smthrs/core`

- `Annotations.d.ts`: `Placement`. Source revisions: `91509fbc4aa2`.
- `Digest.d.ts`: `import "effect/Crypto"`, `provideSync`, `digest`, `import "@smthrs/crypto"`, `import "effect/crypto/Digest"`. Source revisions: `de5ed5c195de`, `91509fbc4aa2`.

### `@smthrs/crypto`

- `Sha256.d.ts`: `import "effect/Crypto"`, `syncCrypto`, `digest`, `Sha256`, `import "effect/crypto/Digest"`. Source revisions: `00ae32d262f3`, `137aa7af94a0`, `9203c511df50`, `33dfb9dfc5e6`, `91509fbc4aa2`.
- `Uuid.d.ts`: `import "effect/Crypto"`, `import "effect/PlatformError"`, `v5`, `import "effect/crypto/Digest"`. Source revisions: `33dfb9dfc5e6`, `91509fbc4aa2`.
- `WebCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `33dfb9dfc5e6`, `91509fbc4aa2`.

### `@smthrs/database`

- `Dialect.d.ts`: `registerReadTransaction`. Source revisions: `c18d01c579c0`, `1058bff5e723`, `91509fbc4aa2`.

### `@smthrs/engine`

- `FlowEngine/ActionKey.d.ts`: `import "effect/Crypto"`, `ordinalScope`, `actionKey`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `f4346a1597cc`, `00ae32d262f3`, `a1bf5be4717f`, `91509fbc4aa2`.
- `FlowEngine/Dispatch.d.ts`: `makeActionExecute`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.
- `FlowEngine/Encoded.d.ts`: `import "effect/Crypto"`, `ActionExecuteOptions`, `Encoded`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `f4346a1597cc`, `00ae32d262f3`, `a1bf5be4717f`, `91509fbc4aa2`.
- `FlowEngine/Round.d.ts`: `import "effect/Crypto"`, `executionId`, `next`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `f4346a1597cc`, `00ae32d262f3`, `a1bf5be4717f`, `91509fbc4aa2`.
- `FlowEngine/Trampoline.d.ts`: `makeExecute`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.
- `index.d.ts`: `export "./StepTrace.ts"`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.
- `StepTrace.d.ts`: `import "effect"`, `import "@smthrs/flow"`, `Event`, `Sink_shape`, `Sink`, `Sink.Shape`, `observed`, `export {}`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.

### `@smthrs/engine-store`

- `ArtifactSync.d.ts`: `import "effect/Crypto"`, `Service`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `DisasterRecovery.d.ts`: `import "effect/Crypto"`, `backup`, `verify`, `restore`, `restoreAndFence`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `DurableEngineState.d.ts`: `WaitingRow`. Source revisions: `33345c88f9a8`, `91509fbc4aa2`.
- `EngineStore.d.ts`: `import "effect/Crypto"`, `PublicRequirements`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `ExecutionSnapshot.d.ts`: `import "@smthrs/run-store/RunStore"`, `withReadTransaction`, `import "@smthrs/database/Dialect"`. Source revisions: `91509fbc4aa2`.
- `OwnerIdentity.d.ts`: `import "effect/Crypto"`, `makeIncarnation`, `layer`, `layerWithoutPid`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `PlanInputStore.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `PlanMergeStore.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `PlanScheduler.d.ts`: `import "effect/Crypto"`, `Requirements`, `Service`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `StepBoundary.d.ts`: `import "effect/Crypto"`, `Service`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `StepSandbox.d.ts`: `import "effect/Crypto"`, `layerTest`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `WorkspaceSandbox.d.ts`: `import "effect/Crypto"`, `Service`, `Host`, `makeMemory`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `internal/ActionPersistence.d.ts`: `make`. Source revisions: `91509fbc4aa2`.
- `internal/AttemptLifecycle.d.ts`: `AttemptLifecycle`, `Snapshot`. Source revisions: `91509fbc4aa2`.
- `internal/CachePublication.d.ts`: `import "effect/Crypto"`, `publishArtifacts`, `hydrateArtifacts`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `internal/CallFacts.d.ts`: `make`. Source revisions: `91509fbc4aa2`.
- `internal/NodeJournal.d.ts`: `import "@smthrs/journal"`, `relativePath`. Source revisions: `91509fbc4aa2`.
- `internal/PlanMerges.d.ts`: `recover`. Source revisions: `91509fbc4aa2`.
- `internal/ResultEnvelope.d.ts`: `ResultEnvelope`, `Settlement`. Source revisions: `91509fbc4aa2`.
- `internal/RunDriver.d.ts`: `import "effect/Crypto"`, `make`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `1cabc2c3fdee`, `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`, `a51a10fd3c40`.
- `internal/SandboxedExecution.d.ts`: `import "effect/Crypto"`, `execute`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `cba78aa015df`, `91509fbc4aa2`.
- `test/TestStores.d.ts`: `layer`, `layerAt`. Source revisions: `91509fbc4aa2`.

### `@smthrs/errors`

- `ErrorShape.d.ts`: `import "./SmithersError.js"`, `import "./SmithersError.ts"`. Source revisions: `91509fbc4aa2`.
- `SmithersError.d.ts`: `import "./ErrorCode.js"`, `SmithersErrorOptions`, `SmithersError`, `isSmithersError`, `export "./ErrorShape.js"`, `import "./ErrorCode.ts"`, `export "./ErrorShape.ts"`. Source revisions: `fca7d8e70154`, `91509fbc4aa2`.
- `index.d.ts`: `export "./SmithersError.js"`, `export "./SmithersError.ts"`. Source revisions: `91509fbc4aa2`.

### `@smthrs/flow`

- `Action/Action.d.ts`: `import "effect/Crypto"`, `IdempotencyKey`, `Action`, `import "effect/crypto/Digest"`. Source revisions: `57d381b332be`, `91509fbc4aa2`.
- `Action/CacheEnvironment.d.ts`: `cachePolicyOf`, `withCache`. Source revisions: `91509fbc4aa2`.
- `Action/Filegroup.d.ts`: `import "@smthrs/plan/FileSet"`, `make`. Source revisions: `91509fbc4aa2`.
- `Action/Implementations.d.ts`: `import "effect/Crypto"`, `Implementation`, `import "effect/crypto/Digest"`. Source revisions: `57d381b332be`, `91509fbc4aa2`.
- `Action/StepIdentity.d.ts`: `import "effect/Crypto"`, `allocationScope`, `invocationKey`, `import "effect/crypto/Digest"`. Source revisions: `57d381b332be`, `91509fbc4aa2`.
- `Action/idempotencyKey.d.ts`: `import "effect/Crypto"`, `idempotencyKey`, `import "effect/crypto/Digest"`. Source revisions: `57d381b332be`, `91509fbc4aa2`.
- `Action/raceAll.d.ts`: `raceAll`. Source revisions: `91509fbc4aa2`.
- `Deadline.d.ts`: `import "effect/Crypto"`, `start`, `bound`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `DurableClock.d.ts`: `import "effect/Crypto"`, `sleep`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `DurableDeferred.d.ts`: `import "effect/Crypto"`, `tokenFromPayload`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `DurableQueue.d.ts`: `import "effect/Crypto"`, `process`, `makeWorker`, `worker`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `ExternalJob.d.ts`: `make`. Source revisions: `91509fbc4aa2`.
- `Flow/Annotations.d.ts`: `Placement`. Source revisions: `91509fbc4aa2`.
- `Flow/ExecutionIds.d.ts`: `import "effect/Crypto"`, `ExecutionIdSource`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `Flow/Flow.d.ts`: `import "effect/Crypto"`, `Flow`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `FlowRuntime/FlowRuntime.d.ts`: `import "effect/Crypto"`, `FlowRuntime_base`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `Graph.d.ts`: `GraphBuildError`, `{ GraphBuildError, isFatalDiagnostic }`. Source revisions: `91509fbc4aa2`.
- `HumanTask.d.ts`: `import "effect/Crypto"`, `payloadFields`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `Interpreter.d.ts`: `import "effect/Crypto"`, `Services`, `childExecutionId`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `Poll.d.ts`: `import "effect/Crypto"`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `Sleep.d.ts`: `import "effect/Crypto"`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `WaitFor.d.ts`: `import "effect/Crypto"`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `57d381b332be`, `91509fbc4aa2`.
- `internal/BoundedJson.d.ts`: `encodedStringBytes`. Source revisions: `91509fbc4aa2`.

### `@smthrs/flows`

- `Runtime.d.ts`: `layer`, `make`. Source revisions: `91509fbc4aa2`.

### `@smthrs/fuzz`

- `Fuzz.d.ts`: `import "effect/Arbitrary"`, `import "effect/Array"`, `import "effect/Cause"`, `import "effect/Context"`, `import "effect/Duration"`, `import "effect/Effect"`, `import "effect/Exit"`, `import "effect/Schema"`, `import "effect/Types"`, `Target`, `Codec`, `TargetOptions`, `target`, `Options`, `Replay`, `Died`, `Deadlock`, `Failure`, `Outcome`, `Finding`, `FlakyFinding`, `Stats`, `Passed`, `Exhausted`, `ReplayMismatch`, `Falsified`, `Flaky`, `Report`, `FuzzError`, `Sink`, `Feedback`, `spans`, `observe`, `score`, `StoredEntry`, `Store`, `Corpus`, `memoryCorpus`, `ScheduleTape`, `ExecutionResult`, `Execution`, `run`, `runTarget`, `formatReport`. Source revisions: `758466676de3`.
- `index.d.ts`: `export "./Fuzz.ts"`, `export "./testing/FuzzSimulation.ts"`. Source revisions: `758466676de3`.
- `internal/arbitrary/model.d.ts`: `import "effect/Cause"`, `import "effect/Effect"`, `ShrinkPull`, `onTypedFailure`, `Sample`, `Discarded`, `Attempt`, `Computation`, `Generation`, `GenerationRandom`, `GenerationState`, `Generator`, `isAttempt`, `toEffectGeneration`, `"effect/Arbitrary".Arbitrary`. Source revisions: `758466676de3`.
- `internal/fuzz/engine.d.ts`: `import "effect/Arbitrary"`, `import "effect/Cause"`, `import "effect/Context"`, `import "effect/Effect"`, `import "../../Fuzz.ts"`, `import "../arbitrary/model.ts"`, `import "./format.ts"`, `FuzzError_base`, `FuzzError`, `TargetTypeId`, `TargetImpl`, `makeTarget`, `observe`, `score`, `spans`, `live`, `jsonCodec`, `Generated`, `generate`, `Outcome`, `signatureOf`, `runTarget`, `Corpus`, `memoryCorpus`, `export {}`. Source revisions: `fd1f5ed37978`, `758466676de3`.
- `internal/fuzz/format.d.ts`: `Input`, `Entry`, `encodeEntry`, `signature`, `decodeEntry`, `ReplayData`, `encodeReplay`, `decodeReplay`. Source revisions: `758466676de3`.
- `internal/fuzz/simulation.d.ts`: `import "effect/Clock"`, `import "effect/Fiber"`, `import "../../Fuzz.ts"`, `import "effect/Scheduler"`, `Timer`, `Outcome`, `World`, `execution`, `export {}`. Source revisions: `758466676de3`.
- `internal/fuzz/tape.d.ts`: `import "../arbitrary/model.ts"`, `mix32`, `hashString`, `hashHex`, `filler`, `Used`, `makeTapeRandom`, `materialize`, `Rng`, `makeRng`, `encodeWords`, `decodeWords`, `spliceTail`. Source revisions: `fd1f5ed37978`, `758466676de3`.
- `testing/FuzzSimulation.d.ts`: `import "../Fuzz.ts"`, `Options`, `execution`. Source revisions: `758466676de3`.

### `@smthrs/gateway`

- `GatewayProjection.d.ts`: `ApprovalRow`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `GatewayRpcs.d.ts`: `SubmitApprovalInput`, `GatewayRpcs`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `GatewaySchema.d.ts`: `served`, `ProjectionSnapshot`, `RowFrame`, `DeltaFrame`, `GatewayFrame`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `RunHistory.d.ts`: `StepEdit`, `ForkInput`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `RuntimeBridge.d.ts`: `LaunchCommand`, `SignalCommand`, `Command`, `CommandResponse`, `ObserveResponse`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `../vendor/bun/BunCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunHttpClient.d.ts`: `export "effect/http/FetchHttpClient"`, `import "effect/http/HttpClient"`, `import "effect/Layer"`, `Options`, `layerOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunHttpServer.d.ts`: `import "bun"`, `make`, `layer`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunRedis.d.ts`: `import "bun"`, `layer`, `layerConfig`, `BunRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `BunServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunHttpClient.d.ts`: `export "effect/http/FetchHttpClient"`, `import "effect/http/HttpClient"`, `import "effect/Layer"`, `Options`, `layerOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunHttpServer.d.ts`: `import "bun"`, `make`, `layer`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunRedis.d.ts`: `import "bun"`, `layer`, `layerConfig`, `BunRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `BunServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `import "ws"`, `export { NodeWS }`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `export "ws"`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeWS.d.ts`: `export "../../ws.mjs"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/NodeWS.d.ts`: `export "ws"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.

### `@smthrs/harness`

- `AgentEvent.d.ts`: `ModelDelta_base`, `DecisionSettled_base`, `CompactionSettled_base`, `SteeringDrained_base`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.
- `Cell.d.ts`: `Complete_base`, `FlowProjection_base`, `Call_base`, `CallResult_base`, `CallResult`, `CallSuccess`, `CallFailure`, `CallResultVariant`. Source revisions: `2dbaaf8edacf`, `3a4c65142ff2`, `91509fbc4aa2`.
- `ContextWindow.d.ts`: `Content`, `Segment_base`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.
- `EngineLike.d.ts`: `SuspendReason_base`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.
- `Steering.d.ts`: `DrainRecord`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.
- `internal/RealmFlowBundle.d.ts`: `source`. Source revisions: `2dbaaf8edacf`, `b5d542c1be62`, `6c4e43c1d18b`, `3a4c65142ff2`, `91509fbc4aa2`.
- `internal/bytes.d.ts`: `size`, `import "../QuickJSLifecycle.ts"`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.
- `QuickJSWorkerd.d.ts`: `import "effect"`, `import "./QuickJSVariant.ts"`, `import "./Sandbox.ts"`, `variantFrom`, `variant`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.
- `internal/quickjsWasm.d.ts`: `"#quickjs.wasm".wasmModule`, `"#quickjs.wasm".ExportAssignment`. Source revisions: `2dbaaf8edacf`, `91509fbc4aa2`.

### `@smthrs/integrations`

- `core.d.ts`: `export "./core/CookieKeys.ts"`. Source revisions: `2255b68209fd`, `91509fbc4aa2`.
- `core/ExternalEvent.d.ts`: `ExternalEvent`. Source revisions: `2255b68209fd`, `91509fbc4aa2`.
- `core/Source.d.ts`: `import "effect/Crypto"`, `Batch`, `RunContext`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `2255b68209fd`, `00ae32d262f3`, `137aa7af94a0`, `7657065fc8bb`, `91509fbc4aa2`.
- `core/SourceRecord.d.ts`: `SourceRecord`. Source revisions: `2255b68209fd`, `91509fbc4aa2`.
- `github.d.ts`: `export "./github/Auth.ts"`, `export "./github/Delegation.ts"`, `export "./github/DelegationPolicy.ts"`, `export "./github/Calls.ts"`, `export "./github/IssueChanges.ts"`, `export "./github/Proposals.ts"`. Source revisions: `724a8dbfc697`, `e39a2306b2b8`, `2255b68209fd`, `91509fbc4aa2`.
- `github/Pulls.d.ts`: `requireHead`. Source revisions: `1f84cfdeef68`, `2255b68209fd`, `91509fbc4aa2`.
- `core/CookieKeys.d.ts`: `import "effect"`, `Verified`, `make`. Source revisions: `2255b68209fd`, `91509fbc4aa2`.
- `github/Auth.d.ts`: `import "effect"`, `import "effect/http"`, `GITHUB_WEB`, `GITHUB_API`, `appSlug`, `GitHubRefused_base`, `GitHubRefused`, `Tokens`, `Permission`, `DeviceSignIn`, `DevicePoll`, `GitHubAuth_shape`, `GitHubAuth_base`, `GitHubAuth`, `GitHubAuth.Shape`, `layer`, `withUserAgent`, `export "./AuthBroker.ts"`. Source revisions: `94798ffe6aaa`, `96c51b179a22`, `27329731b6a8`, `2255b68209fd`, `91509fbc4aa2`.
- `github/AuthBroker.d.ts`: `import "effect"`, `import "./Auth.ts"`, `import "../core/CookieKeys.ts"`, `import "effect/http"`, `httpPolicy`, `START`, `EXCHANGE`, `CALLBACK`, `CONSENT`, `STATE_PREFIX`, `HEADERS`, `REQUEST_TTL`, `CODE_TTL`, `BrokerRefused_base`, `BrokerRefused`, `HostedSite`, `Keys`, `Store`, `canonicalOrigin`, `allowedOrigin`, `ConnectIntent`, `Claims`, `Identity`, `Connections`, `observed`, `memoryStore`, `site`, `make`, `HANDOFF_PAGE`, `HANDOFF_CSP`, `consentHtml`, `CONSENT_CSP`, `consentCsp`, `serve`, `Sql`, `sqliteStore`, `handles`, `export {}`. Source revisions: `0643f98e4e66`, `21b363ea8426`, `e741bff0d08e`, `724a8dbfc697`, `94798ffe6aaa`, `96c51b179a22`, `2255b68209fd`, `91509fbc4aa2`.
- `github/AuthBrokerPolicy.d.ts`: `validDeadline`, `liveRecord`. Source revisions: `96c51b179a22`, `2255b68209fd`, `91509fbc4aa2`.
- `github/Calls.d.ts`: `import "effect"`, `import "./GitHubClient.ts"`, `import "effect/http"`, `withToken`. Source revisions: `e39a2306b2b8`, `2255b68209fd`, `91509fbc4aa2`.
- `github/Delegation.d.ts`: `import "effect"`, `import "./DelegationPolicy.ts"`, `import "./Auth.ts"`, `import "./GitHubClient.ts"`, `import "effect/http"`, `import "@smthrs/flow"`, `ROUTE`, `CALL_TTL`, `EXPIRY`, `REFRESH_MARGIN`, `WRITES_PER_HOUR`, `Reason`, `Mode`, `DelegationRefused_base`, `DelegationRefused`, `Site`, `Keyring`, `Store`, `Journal`, `Act`, `memoryStore`, `memoryJournal`, `Sql`, `sqliteStore`, `personOf`, `handles`, `MAX_BODY`, `serve`, `ReceiptSchema`, `Receipt`, `reasonOf`, `site`, `signer`, `make`, `export {}`. Source revisions: `21b363ea8426`, `724a8dbfc697`, `2255b68209fd`, `91509fbc4aa2`.
- `github/DelegationPolicy.d.ts`: `Scope`, `Grant`, `Operation`, `grantOf`, `permits`, `readable`, `liveDelegation`. Source revisions: `724a8dbfc697`, `2255b68209fd`, `91509fbc4aa2`.
- `github/IssueChanges.d.ts`: `import "effect"`, `import "../core/IntegrationError.ts"`, `import "./GitHubClient.ts"`, `WithAssignees`, `export { WithAssignees }`, `issuePath`, `update`, `link`, `get`, `assignees`, `TimelineEvent`, `timeline`. Source revisions: `5e7564986b26`, `91d2f311e076`, `e39a2306b2b8`, `2255b68209fd`, `91509fbc4aa2`.
- `github/Proposals.d.ts`: `import "effect"`, `import "./GitHubClient.ts"`, `import "../core/IntegrationError.ts"`, `Fork`, `ensureFork`, `ReviewFile`, `DocumentReview`, `documentReview`. Source revisions: `5e7564986b26`, `91d2f311e076`, `e39a2306b2b8`, `2255b68209fd`, `91509fbc4aa2`.

### `@smthrs/journal`

- `CallFact.d.ts`: `Call`, `Result`, `Fact`. Source revisions: `91509fbc4aa2`.
- `EngineEvent.d.ts`: `Success`, `Failure`, `ResultEnvelope`, `AttemptLifecycle`, `AttemptPayload`, `ExecutionLifecycle`, `StatePayload`, `NodeSummary`, `NodeGraph`, `PlanRecordedPayload`, `SubgraphAppendedPayload`, `NodeReconciledPayload`. Source revisions: `91509fbc4aa2`.
- `ExecutionFact.d.ts`: `Observation`, `Fact`, `View`. Source revisions: `91509fbc4aa2`.
- `StepFact.d.ts`: `Fact`. Source revisions: `91509fbc4aa2`.

### `@smthrs/kernel`

- `ChildProcessEnvironment.d.ts`: `credentialNamePattern`, `make`, `import "effect/Redacted"`. Source revisions: `00ae32d262f3`, `d8e3642aae1b`, `91509fbc4aa2`.
- `CommandLine.d.ts`: `env`, `import "effect/Redacted"`, `renderForExecution`. Source revisions: `00ae32d262f3`, `d8e3642aae1b`, `91509fbc4aa2`.

### `@smthrs/keys`

- `DerivedKey.d.ts`: `DerivedKey`. Source revisions: `91509fbc4aa2`.
- `KeyDerivationError.d.ts`: `KeyDerivationError`. Source revisions: `a3268b7cd9b6`, `91509fbc4aa2`.
- `deriveKey.d.ts`: `import "effect/Crypto"`, `deriveKey`, `import "effect/crypto/Digest"`. Source revisions: `a3268b7cd9b6`, `91509fbc4aa2`.

### `@smthrs/memory`

- `MemoryStore.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/SecureRandom"`. Source revisions: `137aa7af94a0`, `50a8a7981185`, `91509fbc4aa2`.
- `internal/Threads.d.ts`: `import "effect/Crypto"`, `make`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `137aa7af94a0`, `50a8a7981185`, `91509fbc4aa2`.
- `test/TestMemory.d.ts`: `import "effect/Crypto"`, `layerWithDatabase`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `137aa7af94a0`, `50a8a7981185`, `91509fbc4aa2`.

### `@smthrs/migrate`

- `flow/Archive.d.ts`: `effectVersion`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `flow/Command.d.ts`: `import "effect/Crypto"`, `Requirements`, `layerNode`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `9c302bbb8b27`, `00ae32d262f3`, `5c921cecd412`, `91509fbc4aa2`.
- `flow/Layers.d.ts`: `layerPlan`, `layerNode`, `layerNodeScanned`, `layerScripted`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `flow/MigrateFlow.d.ts`: `layer`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `flow/Repair.d.ts`: `layer`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `flow/Transform.d.ts`: `layer`. Source revisions: `9c302bbb8b27`, `91509fbc4aa2`.
- `internal/Versions.d.ts`: `effectVersion`, `effectRange`. Source revisions: `9c302bbb8b27`, `8ccbfa0ad758`, `91509fbc4aa2`.
- `../vendor/cjs/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `import "ws"`, `export { NodeWS }`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `export "ws"`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeWS.d.ts`: `export "../../ws.mjs"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/NodeWS.d.ts`: `export "ws"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.

### `@smthrs/model`

- `AnthropicMessages.d.ts`: `Body`. Source revisions: `91509fbc4aa2`.
- `Auth.d.ts`: `import "effect"`, `isCredentialName`, `import "@smthrs/kernel"`. Source revisions: `91509fbc4aa2`.
- `ModelEvent.d.ts`: `ModelEvent`. Source revisions: `91509fbc4aa2`.
- `ModelProxy.d.ts`: `Line`. Source revisions: `91509fbc4aa2`, `1ed7ab080ad0`.
- `ModelRequest.d.ts`: `JsonObject`, `Message`, `ToolDefinition_base`, `ModelRequest_base`. Source revisions: `91509fbc4aa2`.
- `OpenAIChatCompletions.d.ts`: `ResponseFormat`, `Body`, `ChatCompletionChunk`. Source revisions: `91509fbc4aa2`.
- `OpenAIResponses.d.ts`: `Body`, `ChatGPTBody`, `OpenAIEvent`. Source revisions: `91509fbc4aa2`.

### `@smthrs/notifications`

- `Notification.d.ts`: `HumanSteer`, `HumanFollowup`, `SystemEvent`, `Notification`. Source revisions: `91509fbc4aa2`.
- `NotificationEvent.d.ts`: `Admitted`. Source revisions: `91509fbc4aa2`.

### `@smthrs/plan`

- `KeyMaterial.d.ts`: `InputRef`, `KeyMaterial`. Source revisions: `e8969d8cd88c`, `91509fbc4aa2`.
- `Plan.d.ts`: `import "effect/Crypto"`, `PlanNode`, `Plan`, `compile`, `append`, `verify`, `prefixDigest`, `import "effect/crypto/Digest"`. Source revisions: `de5ed5c195de`, `91509fbc4aa2`.
- `StepKey.d.ts`: `import "effect/Crypto"`, `DigestMemo`, `environmentIdentity`, `content`, `ordinal`, `fromKeyMaterial`, `planIdentity`, `dispatchIdentity`, `import "effect/crypto/Digest"`. Source revisions: `de5ed5c195de`, `91509fbc4aa2`.
- `internal/SchemaIdentity.d.ts`: `representationIdentity`. Source revisions: `00ae32d262f3`, `b5d542c1be62`, `91509fbc4aa2`.
- `test/PlanFixtures.d.ts`: `compile`. Source revisions: `91509fbc4aa2`.

### `@smthrs/plan-store`

- `PlanStore.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Digest"`. Source revisions: `de5ed5c195de`, `91509fbc4aa2`.

### `@smthrs/platform-browser`

- `internal/Engine.d.ts`: `import "effect/Crypto"`, `Host`, `layer`, `layerHost`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `00ae32d262f3`, `a3b042c50a0d`, `91509fbc4aa2`.
- `internal/Protocol.d.ts`: `Start`, `Signal`, `Request`, `Replied`, `Message`. Source revisions: `91509fbc4aa2`.

### `@smthrs/platform-bun`

- `BunFileSystem.d.ts`: `export "./BunFileReplacement.ts"`. Source revisions: `e232750c54f3`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `BunHost.d.ts`: `import "effect/Crypto"`, `layer`, `layerAt`, `layerContained`, `layerContainedAt`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `e232750c54f3`, `00ae32d262f3`, `02e51b6c7ba7`, `7b2555d918a8`, `91509fbc4aa2`.
- `index.d.ts`: `export "./BunDesktop.ts"`, `export "./BunServer.ts"`. Source revisions: `e232750c54f3`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `BunDesktop.d.ts`: `import "effect"`, `import "#electrobun"`, `DesktopUnavailable_base`, `DesktopUnavailable`, `DesktopWindow_shape`, `DesktopWindow_base`, `DesktopWindow`, `DesktopWindow.Shape`, `NativeLoader_shape`, `NativeLoader_base`, `NativeLoader`, `NativeLoader.Shape`, `layerWith`, `layer`, `export {}`. Source revisions: `e232750c54f3`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `BunFileReplacement.d.ts`: `import "effect"`, `import "effect/crypto"`, `FileChanged_base`, `FileChanged`, `replaceFileString`, `export {}`. Source revisions: `e232750c54f3`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `BunServer.d.ts`: `import "effect"`, `layer`. Source revisions: `e232750c54f3`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `Electrobun.d.ts`: `BrowserWindow`, `Utils`, `PATHS`, `SMITHERS_BUN14_COMPAT`. Source revisions: `e232750c54f3`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `../vendor/bun/BunCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunHttpClient.d.ts`: `export "effect/http/FetchHttpClient"`, `import "effect/http/HttpClient"`, `import "effect/Layer"`, `Options`, `layerOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunHttpServer.d.ts`: `import "bun"`, `make`, `layer`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunRedis.d.ts`: `import "bun"`, `layer`, `layerConfig`, `BunRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/bun/BunServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `BunServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunHttpClient.d.ts`: `export "effect/http/FetchHttpClient"`, `import "effect/http/HttpClient"`, `import "effect/Layer"`, `Options`, `layerOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunHttpServer.d.ts`: `import "bun"`, `make`, `layer`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunRedis.d.ts`: `import "bun"`, `layer`, `layerConfig`, `BunRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/bun/BunServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `BunServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `import "ws"`, `export { NodeWS }`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `export "ws"`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeWS.d.ts`: `export "../../ws.mjs"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/NodeWS.d.ts`: `export "ws"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.

### `@smthrs/platform-cloudflare`

- `CloudflareHost.d.ts`: `import "@smthrs/engine-store"`, `import "effect/Crypto"`, `CloudflareHost`, `layer`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `f57dff4a0323`, `1058bff5e723`, `ae4e101fd56a`, `7b2555d918a8`, `91509fbc4aa2`.
- `CloudflareRuntime.d.ts`: `import "@smthrs/engine-store"`, `Options`, `layer`, `import "effect/Metric"`, `import "effect/sql/SqlClient"`, `Retention`, `defaultRetentionLimit`, `retentionPasses`, `retainedRunsDeleted`, `retentionLog`. Source revisions: `27353b717cf7`, `f57dff4a0323`, `1058bff5e723`, `91509fbc4aa2`.
- `ExecutionObject.d.ts`: `Intent`. Source revisions: `f57dff4a0323`, `1058bff5e723`, `91509fbc4aa2`.
- `index.d.ts`: `export "./CloudflareHost.ts"`, `export "./ObjectDatabase.ts"`, `export "@smthrs/engine-store"`. Source revisions: `f57dff4a0323`, `1058bff5e723`, `91509fbc4aa2`.
- `ObjectDatabase.d.ts`: `import "@effect/sql-sqlite-do/SqliteClient"`, `import "effect/Layer"`, `import "effect/sql/SqlClient"`, `Storage`, `layer`. Source revisions: `f57dff4a0323`, `1058bff5e723`, `91509fbc4aa2`.

### `@smthrs/platform-node`

- `NativeRuntime.d.ts`: `import "effect/Crypto"`, `Platform`, `make`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Digest"`. Source revisions: `f101d8f56a67`, `00ae32d262f3`, `02e51b6c7ba7`, `7b2555d918a8`, `91509fbc4aa2`.
- `TestNodeRuntime.d.ts`: `requirements`, `durableEngine`, `sqliteObjectStorage`. Source revisions: `c18d01c579c0`, `f101d8f56a67`, `02e51b6c7ba7`, `91509fbc4aa2`.
- `../vendor/cjs/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `import "ws"`, `export { NodeWS }`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeChildProcessSpawner.d.ts`: `import "effect/Array"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeCrypto.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `import "effect/crypto/Aead"`, `import "effect/crypto/Cipher"`, `import "effect/crypto/Digest"`, `import "effect/crypto/Kdf"`, `import "effect/crypto/KeyAgreement"`, `import "effect/crypto/KeyWrap"`, `import "effect/crypto/Mac"`, `import "effect/crypto/SecureRandom"`, `import "effect/crypto/Signature"`, `layerSecureRandom`, `layerDigest`, `layerMac`, `layerKdf`, `layerAead`, `layerCipher`, `layerSignature`, `layerKeyAgreement`, `layerKeyWrap`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSink.d.ts`: `import "node:stream"`, `fromWritable`, `fromWritableChannel`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocket.d.ts`: `import "effect/Array"`, `export "ws"`, `makeNet`, `fromDuplex`, `makeNetChannel`, `layerNet`, `makeTls`, `makeTlsChannel`, `layerTls`, `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeSocketServer.d.ts`: `import "effect/Context"`, `import "./NodeSocket.ts"`, `layerWebSocket`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeStream.d.ts`: `fromReadable`, `fromReadableChannel`, `fromDuplex`, `pipeThroughDuplex`, `toString`, `toArrayBuffer`, `toUint8Array`, `MaxBytesError`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/NodeTerminal.d.ts`: `make`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node-shared/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeCrypto.d.ts`: `import "effect/Crypto"`, `import "effect/Layer"`, `layer`, `export "../node-shared/NodeCrypto.js"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpClient.d.ts`: `import "node:http"`, `import "node:https"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpIncomingMessage.d.ts`: `NodeHttpIncomingMessage`, `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServer.d.ts`: `import "node:http"`, `import "./NodeSocket.ts"`, `make`, `makeHandler`, `makeUpgradeHandler`, `layerServer`, `layer`, `layerConfig`, `import "node:http2"`, `import "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeHttpServerRequest.d.ts`: `import "effect/http/HttpServerRequest"`, `toIncomingMessage`, `toServerResponse`, `import "node:http2"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipart.d.ts`: `import "node:stream"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeMultipartParser.d.ts`: `import "effect/http/MultipartParser"`, `MultipartStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeRedis.d.ts`: `import "effect/Config"`, `layer`, `layerConfig`, `NodeRedisOptions`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeServices.d.ts`: `import "effect/Crypto"`, `import "effect/FileSystem"`, `NodeServices`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/NodeSocket.d.ts`: `import "effect/Duration"`, `layerWebSocketConstructor`, `layerWebSocketConstructorWS`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/node/index.d.ts`: `export "./NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node-shared.d.ts`: `export "./node-shared/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/platform-node.d.ts`: `export "./node/NodeWS.ts"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`.
- `../vendor/cjs/node-shared/NodeWS.d.ts`: `export "../../ws.mjs"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/cjs/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/NodeWS.d.ts`: `export "ws"`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node-shared/internal/stream.d.ts`: `import "node:stream"`, `destroyStream`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/NodeWS.d.ts`: `import "effect/Layer"`, `import "effect/socket/Socket"`, `export "../node-shared/NodeWS.js"`, `layerWebSocketConstructor`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/http.d.ts`: `import "node:http"`, `import "node:https"`, `http`, `https`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.
- `../vendor/node/internal/upgrade.d.ts`: `export {}`. Source revisions: `91509fbc4aa2`, `02e51b6c7ba7`, `9c302bbb8b27`, `58211db0f2d5`.

### `@smthrs/plugin`

- `Config.d.ts`: `ConfigValue`. Source revisions: `91509fbc4aa2`.
- `Manifest.d.ts`: `JsonSchema`, `Args`, `Event`, `Render`, `View`, `Slot`, `Command`, `Keybinding`, `Card`, `Setting`, `Hook`, `Tap`, `Records`, `Manifest`. Source revisions: `91509fbc4aa2`.

### `@smthrs/registry`

- `Descriptor.d.ts`: `SchemaRefModule_base`, `SchemaRefInline_base`, `FlowDescriptor_base`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.
- `Executable.d.ts`: `import "effect/Crypto"`, `Payload`, `Invocation`, `Registration`, `import "effect/crypto/Digest"`. Source revisions: `e8969d8cd88c`, `f4346a1597cc`, `4e6104b3467b`, `91509fbc4aa2`.
- `ExecutionSnapshot.d.ts`: `import "effect/Crypto"`, `makeFileSystem`, `layerFileSystem`, `import "effect/crypto/Digest"`. Source revisions: `f4346a1597cc`, `4e6104b3467b`, `91509fbc4aa2`.
- `Prompt/jsx-runtime.d.ts`: `jsxs`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.
- `index.d.ts`: `export "./Bundled.ts"`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.
- `Bundled.d.ts`: `import "effect"`, `import "@smthrs/flow"`, `BundledError_base`, `BundledError`, `Catalog`, `make`, `export {}`. Source revisions: `f4346a1597cc`, `91509fbc4aa2`.

### `@smthrs/sandbox`

- `RemoteChildProcessSpawner/TestRemote.d.ts`: `TestRemote`, `makeTestRemote`, `export {}`. Source revisions: `91509fbc4aa2`.
- `Sandbox/TestSession.d.ts`: `TestSession`, `makeTestSession`, `export {}`. Source revisions: `91509fbc4aa2`.
- `Sandbox/job.d.ts`: `JobOptions`. Source revisions: `91509fbc4aa2`.
- `SandboxCommand/index.d.ts`: `make`. Source revisions: `91509fbc4aa2`.

### `@smthrs/scorers`

- `Scorers.d.ts`: `rubric`. Source revisions: `91509fbc4aa2`.

### `@smthrs/std`

- `Manifest.d.ts`: `import "./Bash.ts"`, `effectsFor`, `import "./ApplyPatch.ts"`, `import "./Edit.ts"`, `import "./Explore.ts"`, `import "./Fetch.ts"`, `import "./Glob.ts"`, `import "./Grep.ts"`, `import "./HttpPost.ts"`, `import "./Ls.ts"`, `import "./Lsp.ts"`, `import "./Read.ts"`, `import "./ShellCommand.ts"`, `import "./TestRun.ts"`, `import "./UpdatePlan.ts"`, `import "./WebFetch.ts"`, `import "./Write.ts"`. Source revisions: `91509fbc4aa2`.
- `internal/GitWorktree.d.ts`: `GitWorktree`, `git`, `resolveCommit`, `config`, `open`, `withShadow`, `withDetachedWorktree`, `export {}`. Source revisions: `91509fbc4aa2`.

### `@smthrs/sync`

- `SyncProtocol.d.ts`: `Snapshot`. Source revisions: `91509fbc4aa2`.
- `SyncRpcs.d.ts`: `SyncRpcs`. Source revisions: `91509fbc4aa2`.

### `@smthrs/targets`

- `Cargo.d.ts`: `Fmt`, `Clippy`, `Test`, `fmtRule`, `clippyRule`, `testRule`. Source revisions: `91509fbc4aa2`.
- `Factory.d.ts`: `SchedulePayload`, `RuleValue`, `On`, `Declaration`, `Rule`, `Projection`, `Payload`, `FactoryProjectionAction`, `Attrs`, `FactoryProjection`. Source revisions: `91509fbc4aa2`.
- `FlowCatalog.d.ts`: `DiscoveredFlow`, `Row`. Source revisions: `91509fbc4aa2`.
- `Go.d.ts`: `run`. Source revisions: `91509fbc4aa2`.
- `Nix.d.ts`: `bin`. Source revisions: `91509fbc4aa2`.
- `Runtime.d.ts`: `npx`. Source revisions: `91509fbc4aa2`.
- `Smithers.d.ts`: `Owners`, `Npm`, `Docs`, `Home`, `Factory`. Source revisions: `91509fbc4aa2`.

### `@smthrs/testing`

- `Fixture.d.ts`: `Fixture`. Source revisions: `758466676de3`, `91509fbc4aa2`.
- `FlowEngineLike.d.ts`: `import "effect/Crypto"`, `make`, `layer`, `layerOver`, `layerMemory`, `import "effect/crypto/Digest"`, `import "effect/crypto/SecureRandom"`. Source revisions: `758466676de3`, `00ae32d262f3`, `bdd6e7bc1eab`, `91509fbc4aa2`.
- `Vitest.d.ts`: `it`, `import "./internal/FuzzRegistration.ts"`, `FuzzIt`. Source revisions: `758466676de3`, `91509fbc4aa2`.
- `index.d.ts`: `export "./internal/fuzz.ts"`. Source revisions: `758466676de3`, `91509fbc4aa2`.
- `internal/FuzzRegistration.d.ts`: `import "@smthrs/fuzz"`, `import "effect"`, `import "vitest"`, `import "./fuzz.ts"`, `FuzzOptions`, `Value`, `Values`, `EffectFuzz`, `SyncFuzz`, `makeMethods`, `export {}`. Source revisions: `758466676de3`, `91509fbc4aa2`.
- `internal/fuzz.d.ts`: `import "effect/Arbitrary"`, `import "effect/Effect"`, `import "@smthrs/fuzz"`, `import "effect/Schema"`, `ArbitraryInput`, `Arbitraries`, `session`, `sessionTimeout`, `segment`, `fileCorpus`, `corpusDirectories`, `makeTarget`, `runFuzz`. Source revisions: `758466676de3`, `91509fbc4aa2`.

### `@smthrs/time-travel`

- `TimeTravel.d.ts`: `forkWorkspaceName`. Source revisions: `91509fbc4aa2`.
- `TimeTravelStore.d.ts`: `StepOverride`. Source revisions: `91509fbc4aa2`.

### `@smthrs/triggers`

- `Trigger.d.ts`: `Trigger`. Source revisions: `91509fbc4aa2`.

### `@smthrs/views`

- `internal/bytes.d.ts`: `utf8Length`, `import "@smthrs/harness"`, `{ utf8Length }`. Source revisions: `91509fbc4aa2`.

## Source revision ledger

The inventory cites module and manifest changes together. Dependency-only rows
resolve to the compiler/dependency update. Private adapter rows also cite the
Undici pin corrections and the declaration-copy repair.

- `00ae32d262f3`: 🐛 fix(sdk): put module headers first and drop imports the Effect 4.1 move left unused
- `02e51b6c7ba7`: ⬆️ chore(deps): align private adapters with Effect 4.1 Undici
- `05d05f2072f6`: 🧪 test(vibelang): verify original source maps and generator processes
- `0643f98e4e66`: ✨ feat(vibelang): connect GitHub through smithers.sh and hold no token
- `08f7483a743f`: ⬆️ chore(deps): align Alchemy providers and VibeLang tooling
- `1058bff5e723`: ✨ feat(platform-cloudflare): run the engine in a Durable Object's own SQLite
- `1097de48fdd4`: 🐛 fix(cli): keep Electrobun out of the TUI bundle
- `137aa7af94a0`: 💅 style(sdk): format migrated Effect service definitions
- `1729e9add541`: ♻️ refactor(capability): construct schema errors through factories
- `186575ce8d27`: 🐛 fix(coverage): merge subprocess source ranges accurately
- `1b42117f2559`: 🐛 fix(vibelang): preserve Effect JSON schema key metadata
- `1c745d98d9e4`: ✨ feat(vibelang): run every post as a durable vibelang/Post flow
- `1cabc2c3fdee`: 🐛 fix(engine-store): retain control wakes across timer parking
- `1d79c56e0ce0`: ♻️ refactor(build): adopt Effect 4.1 host and SQL requirements
- `1ed7ab080ad0`: 🐛 fix(model): retain request context during stream cleanup
- `1f84cfdeef68`: 🐛 fix(integrations): accept a fork's owner:branch head when opening or listing pull requests
- `21b363ea8426`: ✨ feat(mvp): host one GitHub connection per person on smithers.sh
- `2255b68209fd`: ♻️ refactor(auth): share GitHub sign-in and rotating cookie keys
- `23632a4c998c`: 🐛 fix(vibelang): declare its test dependency on apps/mvp
- `27329731b6a8`: ✨ feat(integrations): GitHub device flow in GitHub.Auth
- `27353b717cf7`: ✨ feat(cloudflare): delete a Durable Object's settled engine history at runtime build
- `2dbaaf8edacf`: ✨ feat(harness): ship the workerd QuickJS build as QuickJSWorkerd
- `308a3f7b9acb`: 🐛 fix(persistence): await initial leadership before index requests
- `33345c88f9a8`: 🐛 fix(engine-store): rehydrate Effect 4.1 deferred failure records
- `33dfb9dfc5e6`: ♻️ refactor(crypto): use Effect 4.1 digest and random services
- `3a4c65142ff2`: ♻️ refactor(harness): preserve call admission through schema factories
- `3c193ddf2700`: ✨ feat(vibelang): the live agent on Cloudflare as a durable flow
- `400de3367b96`: ♻️ refactor(ui): consume framework-free @smthrs/ui-css from package roots
- `4792038b8aba`: 🐛 fix(deps): repair upgraded platform and serialization adapters
- `4e6104b3467b`: ♻️ refactor(agent): migrate supporting package factories and host services
- `50a8a7981185`: ♻️ refactor(memory): use the SecureRandom service for identifiers
- `57d381b332be`: ♻️ refactor(flow): use Effect 4.1 digest and random service requirements
- `58211db0f2d5`: 🐛 fix(build): preserve WebSocket declarations in private CommonJS adapters
- `5c921cecd412`: ♻️ refactor(cli): migrate Effect 4.1 services and schema factories
- `5c9d26ffffef`: ♻️ refactor(control): compose Effect 4.1 digest services explicitly
- `5e7564986b26`: ✨ feat(integrations): read native proposal review evidence and timeline timestamps
- `6b347aff0449`: ✨ feat(lemmascript): vendor LemmaScript 0.6.6 with spread and tagged match support
- `6c2a317072ed`: 🏗️ build(vibelang): join the pnpm workspace and declare the app's targets
- `6c4e43c1d18b`: 🏗️ build(harness): refresh the shipped Effect 4.1 realm bundle
- `724a8dbfc697`: ✨ feat(integrations): add per-person GitHub delegation for hosted sites
- `758466676de3`: ✨ feat(fuzz): package the Effect fork fuzzer and Vitest corpus tooling
- `7657065fc8bb`: ♻️ refactor(integrations): migrate Effect and VibeLang boundaries
- `766882291721`: ✨ feat(vibelang): answer with smithers.sh's agent on Cloudflare
- `7b2555d918a8`: ♻️ refactor(platform): provide Effect 4.1 crypto services at host boundaries
- `80307dada4f9`: 🐛 fix(gateway): preserve external schemes with Effect 4.1 transport URLs
- `8ccbfa0ad758`: ⬆️ chore(deps): pin generated projects and release guards to Effect 4.1.1
- `8f19d24637dc`: 🐛 fix(build-cli): read each shared declared input once per plan
- `91509fbc4aa2`: ⬆️ chore(deps): move to Effect 4.1.1, VibeLang 0.0.12 and Alchemy beta.85
- `91d2f311e076`: 🐛 fix(integrations): preserve proposal ownership and complete issue history
- `9203c511df50`: 🛠️ fix(crypto): support captured synchronous digest methods
- `94798ffe6aaa`: 🐛 fix(auth): revoke temporary GitHub tokens in the hosted broker
- `965fb7664394`: ✨ feat(vibelang): add metered conversation sandboxes
- `96c51b179a22`: ✨ feat(auth): broker hosted sign-in through smithers.sh's existing callback
- `9c302bbb8b27`: 🐛 fix(deps): pin every private adapter owner to Effect 4.1.1's undici
- `a1bf5be4717f`: ♻️ refactor(engine): bind Effect 4.1 host services explicitly
- `a3268b7cd9b6`: ♻️ refactor(keys): require the Effect 4.1 Digest service
- `a3b042c50a0d`: ♻️ refactor(platform-browser): adapt Effect 4.1 host services
- `a51a10fd3c40`: 🐛 fix(engine-store): drain scoped registrations before releasing handlers
- `a9e180e22a59`: ♻️ refactor(artifacts): adapt Effect 4.1 digest boundaries
- `ae4e101fd56a`: 🐛 fix(platform-cloudflare): keep the module header first and name the 4.1 crypto services
- `b5d542c1be62`: 🐛 fix(plan): preserve durable schema identities across Effect 4.1 metadata
- `bdd6e7bc1eab`: ♻️ refactor(testing): bind Effect 4.1 digest services in test hosts
- `bdf293025247`: ✨ feat(vibelang): whole-app fuzz suite through a durable flow
- `c18d01c579c0`: 🐛 fix(smithers): classify node:sqlite constraint errcodes and add ObjectStorage list cursors
- `c7defaa87e49`: ♻️ refactor(agent): adapt Effect 4.1 services and durable resume scheduling
- `cba78aa015df`: ♻️ refactor(engine-store): adopt Effect 4.1 persistence requirements
- `ccb50737dc71`: 🧪 test(vibelang): merge workerd execution evidence into the benchmark coverage gate
- `d8e3642aae1b`: ♻️ refactor(kernel): adopt Effect 4.1 filesystem and protected command arguments
- `de5ed5c195de`: ♻️ refactor(flows): adapt durable support packages to Effect 4.1
- `e0696449f0c8`: 🐛 fix(repo-targets): ImportAnalysis reads .vibe with VibeLang's parser
- `e232750c54f3`: ✨ feat(platform-bun): add native desktop host services
- `e39a2306b2b8`: ✨ feat(integrations): share person-scoped GitHub issue changes and proposals
- `e741bff0d08e`: 🐛 fix(integrations): reconcile hosted-site delegation with broker token revocation
- `e8969d8cd88c`: 🐛 fix(flow): load Vibe siblings and retain void plan inputs
- `f101d8f56a67`: 🧪 feat(platform-node): run Vibe guests and expose SQLite object storage
- `f4346a1597cc`: ✨ feat(registry): list bundled flows and observe engine steps
- `f57dff4a0323`: 🐛 fix(cloudflare): expose run inspection and load VibeLang test dependencies
- `fca7d8e70154`: ♻️ refactor(errors): adopt explicit VibeLang effects and error classes
- `fd1f5ed37978`: 🐛 fix(fuzz): splice large corpus tapes without argument overflow

## Validation

The historical baseline reproduces every recorded hash. The original landing
command refuses unchanged main with exit `1`. After the readonly source repair, the
owning generator records the initial 52-package candidate and a fresh invocation
of the unchanged check passes. That initial candidate differs from the initial
reviewed declarations only in `errors/SmithersError.d.ts`, where the two readonly
modifiers are restored. The publication export maps at that stage match the
initial comparison. Later API additions and the separate stored-schema typing
repair are itemized above.

The errors package passes its consumer typecheck and all 66 runtime tests,
including the built ESM/CommonJS boundary, with 100% measured coverage. The
strict testing-package consumer typecheck and regenerated API-docs check pass.
These checks do not claim a full repository-suite or published-version upgrade
qualification.
