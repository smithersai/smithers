---
title: "Exported members"
description: "The public surface of @smthrs/fs as one index: 8 namespaces and 42 documented members."
---

The surface of `@smthrs/fs` is 8 namespaces and 42 documented members. Anything
the package exports that this index does not name is internal. For signatures,
behavior, and errors, see the [API reference](./api.md).

## `Command`

`@smthrs/fs/Command`

| Export           | Kind      | Category     | Summary                                               |
| ---------------- | --------- | ------------ | ----------------------------------------------------- |
| `ListedCommand`  | interface | models       | A route advertised to an agent.                       |
| `ParsedCommand`  | interface | models       | A decoded command-string invocation.                  |
| `CommandSurface` | interface | models       | Runtime projection of a route manifest for agent use. |
| `make`           | const     | constructors | Constructs a command surface from routes.             |

## `CommandTree`

`@smthrs/fs/CommandTree`

| Export                    | Kind      | Category     | Summary                                                                |
| ------------------------- | --------- | ------------ | ---------------------------------------------------------------------- |
| `maximumRoutes`           | const     | constants    | Maximum routes accepted by one tree.                                   |
| `maximumTotalSegments`    | const     | constants    | Maximum total path segments accepted by one tree.                      |
| `maximumResolutionTokens` | const     | constants    | Maximum tokens accepted by one direct resolution request.              |
| `CommandTree`             | interface | models       | A node of the command trie.                                            |
| `Resolved`                | interface | models       | A route selected from an argv prefix, with the unconsumed tokens.      |
| `make`                    | const     | constructors | Builds one immutable command trie.                                     |
| `resolve`                 | const     | constructors | Resolves the longest routable prefix of an argv.                       |
| `resolveExact`            | const     | constructors | Resolves one complete route name and refuses unconsumed path segments. |
| `traverse`                | const     | getters      | Lists every route in stable segment order.                             |

## `Directive`

`@smthrs/fs/Directive`

| Export    | Kind  | Category     | Summary                                                                    |
| --------- | ----- | ------------ | -------------------------------------------------------------------------- |
| `Literal` | type  | models       | A placement literal produced by registry discovery.                        |
| `compile` | const | constructors | Compiles a discovered placement literal into the corresponding core value. |

## `FileRouter`

`@smthrs/fs/FileRouter`

| Export       | Kind      | Category     | Summary                                                             |
| ------------ | --------- | ------------ | ------------------------------------------------------------------- |
| `ScanConfig` | interface | models       | Configuration for one bounded file-router scan.                     |
| `Warning`    | type      | models       | A non-fatal diagnostic emitted by registry discovery.               |
| `ScanResult` | interface | models       | The immutable metadata-only result of scanning a flows tree.        |
| `scan`       | const     | constructors | Scans a flows root without importing or evaluating any flow module. |

## `FlowInvoker`

`@smthrs/fs/FlowInvoker`

| Export        | Kind      | Category     | Summary                                            |
| ------------- | --------- | ------------ | -------------------------------------------------- |
| `Invocation`  | interface | models       | One materialized invocation.                       |
| `FlowInvoker` | service   | services     | Executes a materialized flow.                      |
| `make`        | const     | constructors | Constructs a flow invoker from an implementation.  |
| `makeNoop`    | const     | constructors | Constructs an invoker that fails every invocation. |
| `layerNoop`   | const     | layers       | Provides an invoker that fails every invocation.   |

## `FsError`

`@smthrs/fs/FsError`

| Export    | Kind  | Category | Summary                                                           |
| --------- | ----- | -------- | ----------------------------------------------------------------- |
| `Code`    | type  | models   | Stable failure codes for routing, parsing, loading, and decoding. |
| `FsError` | error | errors   | A recoverable file-routing failure.                               |

## `Incur`

`@smthrs/fs/Incur`

| Export        | Kind    | Category     | Summary                                                                     |
| ------------- | ------- | ------------ | --------------------------------------------------------------------------- |
| `selfSegment` | const   | constants    | The reserved child segment that invokes a route which also has children.    |
| `Host`        | service | services     | The process facts a served CLI reads and the channels it writes.            |
| `createCli`   | const   | constructors | Projects routes onto an Incur CLI while preserving metadata-only discovery. |

## `Route`

`@smthrs/fs/Route`

| Export                   | Kind      | Category     | Summary                                                                             |
| ------------------------ | --------- | ------------ | ----------------------------------------------------------------------------------- |
| `maximumRouteDepth`      | const     | constants    | Maximum number of path segments in one route.                                       |
| `maximumSegmentLength`   | const     | constants    | Maximum UTF-16 length of one route segment.                                         |
| `maximumRouteNameLength` | const     | constants    | Maximum UTF-16 length of one slash-joined route name.                               |
| `maximumPathLength`      | const     | constants    | Maximum UTF-16 length of one source or companion path.                              |
| `maximumCapabilities`    | const     | constants    | Maximum number of capabilities declared by one route.                               |
| `Kind`                   | type      | models       | How a route's body is stored on disk.                                               |
| `Route`                  | interface | models       | A path-derived command route.                                                       |
| `Manifest`               | interface | models       | Generated applications augment this map with route-specific input and output types. |
| `Name`                   | type      | models       | A route name, narrowed to generated manifest keys when one is available.            |
| `Input`                  | type      | models       | The decoded input accepted by a named route.                                        |
| `Output`                 | type      | models       | The decoded output returned by a named route.                                       |
| `snapshot`               | const     | constructors | Copies and validates caller-owned route metadata before asynchronous use.           |
| `isCommandRoute`         | const     | guards       | True only for routes the agent and Incur command surfaces may execute.              |
| `load`                   | const     | constructors | Materializes the flow behind a route.                                               |
