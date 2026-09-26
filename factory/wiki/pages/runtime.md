# Runtime portability and ownership

Flow definitions and domain services are Effect programs. Runtime selection, connection creation and process spawning belong to injected host services.

## Two hosts, one factory

`NodeRuntime` and `BunRuntime` both call the same `makeNative` factory. Each binds its own database layer, host module and crypto layer: `NodeDatabase`, `NodeHost` and `NodeCrypto` for Node; `BunDatabase`, `BunHost` and `BunCrypto` for Bun. Both expose the same `storage`, `make`, `layer` and `layerHost` entry points.

## Shared composition

`Runtime.storage` provides the migrated database, durable stores, owner minter, workspace and local artifact store without constructing an engine. It opens no driver; native entrypoints compose their matching database and platform layers. The artifact store lives in an `objects` directory beside the database file.

`Runtime.layer` builds the engine over those stores, with credential redaction under the engine. Flow registration finishes before the resulting services are exposed, so a persisted run cannot resume before its flow has been registered.

## Host scope

`layerHost` takes a database filename, a workspace root, an owner and the registered flows. The outer executable runs the Effect and owns its scope; closing that scope initiates runtime shutdown. `signals: []` leaves signal handling with an embedding application. Browser and edge hosts need their own adapters.

## Drivers

The Node adapter requires Node's SQLite implementation; under Bun, select `@smthrs/database/bun/BunDatabase`. Both drivers reject legacy Smithers 0.x databases before adding tables.

## Cross-runtime regression

`NativeRuntimeParity.test.ts` runs a fixture in separate Node and Bun processes, in both orders. The first runtime parks a run with one dispatch, the second resumes it to completion, and reopening it in the first must still show one dispatch. The cases are skipped when `bun` is not installed. The test file is coverage, not a record that a run passed.
