---
title: "Filesystem routing contract"
description: "The normative visibility, schema, path, snapshot, resource, and error behavior of @smthrs/fs."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/fs/docs/contract.md"
---

This page states the behavior every surface of `@smthrs/fs` guarantees. For
the mental models behind it, see [Metadata routing](/concepts/metadata-routing/)
and [Command projections](/concepts/command-projections/).

## Boundary order

One scan snapshots its configuration, resolves the root to an absolute path,
and uses that value for the entire asynchronous operation. Discovery stays
metadata-only. Route construction then validates and freezes every field,
including schema locators, effect declarations, capabilities, placement, and
companion paths.

An invocation follows this order:

1. Resolve one canonical slash-joined route name.
2. Load only that module through an escaped absolute file URL.
3. Project its loaded Effect input schema into CLI descriptors.
4. Decode and detach the input through the authoritative Effect schema.
5. Invoke through `FlowInvoker`.
6. Encode and detach the output through the authoritative Effect schema.

Missing schema services, parse failures, validation failures, and defects are
all converted to sanitized `FsError` values. Raw arguments, input values,
output values, and implementation causes are never retained in those errors.
Incur maps invoker defects, synchronous throws, and non-`FsError` failures to
`invocation_unavailable` with the fixed message `The flow invocation failed`.
Deliberately public typed `FsError` failures keep their code and description.
Interruption remains interruption. Original unexpected causes go only to the
host's Effect debug logger; built-in console logging uses stderr. Custom
loggers must keep diagnostics private from client output.

Middleware registered with Incur's `use()` guards HTTP, CLI, and MCP command
invocations in registration order, including guards added after discovery has
initialized the metadata surface.

## Identity and paths

`Route.name` must equal `Route.segments.join("/")`. Direct calls require an
exact match; parsing uses the longest command prefix and leaves the remainder
for arguments. A listed slash name is normalized to those same segments in
both the direct command and Incur CLI surfaces.

Filesystem segmentation uses the active `Path.sep`. A literal backslash on
POSIX remains part of one segment and cannot collide with a nested directory.
Absolute filesystem paths are converted with the registry's file-specifier
encoder, so spaces, Unicode, percent signs, hashes, and query characters name
the intended file rather than URL structure.

Route names and segments are canonicalized to Unicode NFC when a route is
snapshotted, and a resolution token is normalized the same way before it is
looked up. A decomposed directory name from the filesystem and a composed name
from a browser or an agent therefore select the same route. Only the lookup key
is normalized: unconsumed argument text stays exactly as the caller wrote it.

## Advertised input schema

Every mounted command publishes the JSON Schema of the flow's own Effect input
schema, so `--help`, `--llms`, `--schema`, the OpenAPI document, and the MCP
tool list describe the input the flow accepts. Unions and nullable fields keep
every branch. Nested objects retain their properties, required keys, and
additional-property schemas; arrays retain their element types, and tuples
retain their positional types and rest elements. Arrays without an element
schema advertise unconstrained items. A literal set is advertised as its exact
values, so
`Schema.Number`, which Effect renders as `number | "Infinity" | "-Infinity" |
"NaN"`, is published with that shape rather than as an untyped value. Building
the metadata surface loads every command module once and reuses the result;
dispatching one command still loads only that command.

The projection is enforced, not decorative. Input that contradicts the
advertised type is refused by Incur before the flow is loaded, with a
field-level error naming the failing path and no copy of the offending value.
A projection describes types only: refinements such as a minimum length or a
pattern reach the authoritative Effect decoder, which refuses them with
`decode_failed`. A flag value is never coerced by shape, so `""`, `null`, and
`[]` are refused for a numeric field instead of becoming `0`.

A flow whose input is a single value rather than an object takes that value
from the first positional or from `input`, as a flag, a query parameter, a JSON
body field, or an MCP argument. Every other token is refused with
`decode_failed` instead of being dropped: an unknown flag, a second positional,
and a positional beside a named `input`. Only an omitted value counts as absent,
so an explicit `null` reaches the flow schema, which decides whether it is
accepted.

The published schema is the flow's, so it also inherits what that schema says
about values this package will not carry. Effect renders a number's JSON form
as `number | "Infinity" | "-Infinity" | "NaN"`, and a date as a string, while
the authoritative decoder and the snapshot boundary accept only inert, finite
JSON. Such a value is refused with `decode_failed` rather than invoked.

A route that cannot be projected at all, such as one declaring an output
locator as its input, stays advertised because it stays dispatchable. Calling
it reports the `FsError` that stopped the projection. Document-generation and
projection failures report sanitized `unsupported_schema` errors for that
route. Missing, external, and cyclic schema references are unsupported. Other
routes remain available through help, OpenAPI, and MCP discovery.

## Command groups and the reserved `self` segment

Incur cannot represent a node that is both runnable and a command group. A
route that also has children, such as `domains` beside `domains/list`, is
therefore advertised and dispatched under the reserved child segment `self`:
`domains self` on the CLI and `/domains/self` over HTTP. Both forms appear in
`--llms`, `--schema`, the OpenAPI document, and the MCP tool list, so nothing
executable is left undiscoverable. The bare name keeps dispatching to the same
route, because a request naming it exactly does not need its children mounted.
A child route literally named `self` under such a route is rejected with
`duplicate_route`.

## Request paths

Each HTTP path segment is split first and percent-decoded afterwards, so `%2F`
decodes inside one segment and can never invent a path boundary; no route
segment may contain a slash, so such a request simply matches nothing. A
malformed percent escape fails `parse_failed` rather than raising a decoder
defect.

Only `unknown_command` falls back to metadata and help output. A resolution
that exceeds its resource bounds, a malformed request path, or a route that
resolves but cannot be loaded or projected is reported as its own typed
`FsError` on both the CLI and HTTP surfaces.

`serve` treats a non-empty `COMPLETE` environment variable as a request for
completion and metadata output, matching Incur. An empty value is ignored.

## Command lexing

Single quotes are literal: a backslash inside them is an ordinary character, so
a Windows path or a regular expression survives unchanged. Unquoted and
double-quoted text honor backslash escapes. Shell syntax is never evaluated.

Quoted empty argument values are preserved. Route resolution snapshots the
full argv under command-token bounds. Route-name restrictions apply while
selecting a route prefix; unconsumed arguments retain their original text
and may contain up to 16384 UTF-16 code units each.

## Snapshot semantics

Routes, trie nodes, maps, scan results, warnings, command inputs, decoded
values, and encoded values are detached from caller-owned containers and
frozen before they cross an asynchronous boundary. Accessors, proxies that
throw, exotic prototypes, sparse arrays, cycles, repeated references,
non-finite numbers, malformed Unicode, symbol keys, and prototype-control
keys are refused without executing user code.

## Resource limits

| Boundary                 |                   Limit |
| ------------------------ | ----------------------: |
| Routes per tree or scan  |                     256 |
| Route depth              |             64 segments |
| Total trie segments      |                    4096 |
| Route segment            |   255 UTF-16 code units |
| Route name               |  4096 UTF-16 code units |
| Source or companion path | 16384 UTF-16 code units |
| Capabilities per route   |                     256 |
| Command text             |       65536 UTF-8 bytes |
| Command tokens           |                    4096 |
| Command token            | 16384 UTF-16 code units |
| Invocation JSON          |   1048576 encoded bytes |
| Invocation JSON depth    |                      64 |
| Invocation JSON members  |                    4096 |
| Invocation JSON nodes    |                    8192 |
| Invocation JSON string   |     65536 encoded bytes |
| Invocation JSON key      |      1024 encoded bytes |

Exact limits succeed. One-over inputs fail with `resource_limit` or
`invalid_route`, depending on whether the bound belongs to the container or
to one route declaration.

## Error codes

| Code                     | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `root_missing`           | The scan root does not exist.                                    |
| `invalid_root`           | The root or scan configuration is invalid.                       |
| `read_failed`            | Discovery or companion inspection could not read the filesystem. |
| `discovery_failed`       | Registry discovery failed without a more specific category.      |
| `parse_failed`           | Command token, option grammar, or request path was invalid.      |
| `unknown_command`        | No visible route, or no exact route, matched.                    |
| `duplicate_route`        | Two routes claimed one command identity, `self` included.        |
| `invalid_route`          | Route metadata violated its immutable contract.                  |
| `resource_limit`         | A bounded command, scan, trie, or value exceeded its limit.      |
| `load_failed`            | The selected module could not be imported or exports no flow.    |
| `unsupported_body`       | A non-module route was sent to the loader.                       |
| `unsupported_schema`     | A schema locator or schema cannot describe command input.        |
| `decode_failed`          | Input failed descriptor or Effect schema decoding.               |
| `encode_failed`          | Output failed Effect schema encoding.                            |
| `invocation_unavailable` | Execution is unavailable or failed unexpectedly.                 |

For cause-by-cause remedies, see [Troubleshooting](/troubleshooting/).
