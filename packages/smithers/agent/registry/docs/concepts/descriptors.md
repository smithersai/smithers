---
title: "Descriptors"
description: "Why discovery is metadata-only, what a FlowDescriptor carries, how a content digest keeps a lazily loaded body honest, and what a registry snapshot owns."
sidebar:
  order: 1
---

A `FlowDescriptor` is what discovery produces: everything about one flow except
the flow itself. It is a serializable value, so a host can journal it, send it
over a wire, or compare two of them, and nothing in it is a closure, a module
handle, or an open file.

## Discovery is metadata-only

Scanning a source never evaluates a module and never reads a prompt body into
the result. The scan reads and hashes each entry file whole, up to
`Discovery.entrySizeLimit`, then parses at most its first 64 KiB looking for the
metadata: the closing frontmatter fence for markdown, the end of the default
`Flow.make` value for a module. The 64 KiB ceiling bounds metadata parsing,
not the read.

For module entries, discovery also scans the complete source and walks its
import closure, bounded to 512 modules and 16 MiB per entry. It reads ancestor
`package.json`, `tsconfig.json` and `jsconfig.json` files to resolve project
aliases, and compiles `.mdx` helpers with `@mdx-js/mdx`. It never evaluates a
discovered flow module. TypeScript and VibeLang sources containing `import(...)` are also parsed with
`@babel/parser` to identify erased import types.

That rule is what makes a catalog cheap enough to build at startup, and it is
also what makes it safe. A `.smithers/flows/` directory is a directory a person edits and
a pack installs into. Evaluating every module in it to find out what is there
would run third-party code before anyone decided to.

The consequence is that a descriptor describes a schema by reference rather
than by value. `SchemaRefModule` records that a module's default export has an
`input` field and where the file is; it does not hold the schema, because
holding it would mean importing the module. A proven literal payload using
String, Number, Boolean or Null from an unshadowed Effect Schema import can
also carry an optional JSON Schema `document` for display. Aliases are supported;
dynamic or refined schemas retain their locator and report unavailable display
metadata. Planning and execution use the module's actual decoder in every case.
A markdown flow's input and output
are fixed, so `SchemaRefMarkdownArgs` and `SchemaRefMarkdownOutput` are markers
with nothing to locate. `SchemaRefInline` is the one variant that carries a
schema by value, as a JSON Schema document, for a host that already holds the
declaration and has nothing to point at.

## The body stays behind a reference

`FlowDescriptor.body` is a `BodyRef`: a path, and for a markdown body the
directory its own resources are resolved against. Loading is a separate,
explicit call, `Registry.loadBody`, and it is the only registry read that
touches the filesystem again.

A `BodyRef` also records `contentDigest`, the SHA-256 of the complete entry
file measured during the scan. That digest is what makes a lazily loaded body
honest. `Registry.loadBody` and `Executable.fromDescriptor` rehash the bytes
they read and refuse with `body_unavailable` when the file changed after
discovery or `contentDigest` is absent. Older journaled descriptors still decode
and can be listed, but their unmeasured bodies cannot be loaded or run. Refresh
the registry to measure the current bytes before loading them. A module
body also records the digest of every module it reaches through static
relative imports, and `Executable.fromDescriptor` refuses when any of them
changed. The default executable loader evaluates the verified bytes of that
whole closure under fresh module identities, so refresh adopts an edited
entry or helper, including its priority, cache, and placement annotations,
even after an earlier load in the same process. Discovery also measures literal
`import()` and `require()` project helpers and mapped aliases. TypeScript
import types such as `type T = import("./types.ts").T` and
`typeof import("./types.ts")` in type annotations are pinned too, but are
erased and do not count as runtime loads. Executable
admission refuses those runtime loads, tsconfig aliases and conditional
package mappings without one static target before evaluating the entry: their
host cache cannot guarantee fresh measured bytes, and deferred calls can
outlive temporary cleanup. Use relative static imports or a package `imports`
key naming one static target. Installed packages without project mappings and
Node/Bun builtins retain host trust.

A load whose target is computed (`createRequire(...)`, `import(name)`) cannot be
measured before the run. Discovery records that the module computes it, and a
host with a `LoadGuard` admits the flow and decides each such load when it
happens: a file outside the flow's source root loads, which is how a flow loads
the compiler and configuration of the repository it works on, and an unmeasured
file under the source root is refused by name. A host without a guard refuses
the flow.

Body paths may be filesystem paths or `file:` URLs. Verification decodes file
URLs, including percent-encoded filenames, through the host `Path` service.
Custom module loaders receive the original URL plus the verified bytes, their
digest, and the verified closure. The default loader imports private temporary
siblings of the entry and each module it reaches, preserving every directory
for relative imports and package resolution. See
[Executable.Options](../api.md#executableoptions) for loader requirements and
catalog deadlines.

## What a descriptor carries

| Field             | What it is                                                          |
| ----------------- | ------------------------------------------------------------------- |
| `name`            | The registry name, derived from the source's naming mode.           |
| `description`     | The one line a model and an autocomplete list are shown. Required.  |
| `body`            | The `BodyRef` and its content digest.                               |
| `input`, `output` | `SchemaRef` locators, or the fixed markdown markers.                |
| `model`           | The declared seat, as an `Option<string>`.                          |
| `flows`           | The collaborator flows the declaration named.                       |
| `capabilities`    | The authority patterns the declaration named.                       |
| `effects`         | Reads, writes, mode, conflict policy, and reversibility tier.       |
| `placement`       | The declared execution environment, as an `Option`.                 |
| `modelInvocable`  | Whether the flow is disclosed to a model.                           |
| `budget`          | The ceilings a control plane should approve, when one was declared. |
| `path`            | The entry file the descriptor was read from.                        |
| `frontmatter`     | Every frontmatter key, retained verbatim as JSON.                   |
| `provenance`      | The source, the root, and the pack, when there was one.             |

`effects` and `capabilities` are the declared-authority half, and they carry
more weight than a label: read [Declared authority](./authority.md).

## A registry owns what it hands out

Every registry constructor copies each descriptor and every array, record, and
option inside it, freezes the copy, and snapshots the configuration it was
given. Two consequences a caller can rely on:

| Action                                                               | Effect on later reads                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Mutating a descriptor passed to `layerFromDescriptors`               | None. The registry answers from its own copy.              |
| Mutating a descriptor returned by `list`, `visible`, or `get`        | Rejected. Returned descriptors are frozen.                 |
| Mutating the `sources` or `packs.installed` array after construction | None. The configuration was snapshotted.                   |
| Mutating an `Invocation` a delegate received                         | Rejected. The envelope and its contents are frozen copies. |

The envelope matters twice over, because the same values are captured as the
delegating node's durable identity. Freezing them is what keeps the envelope a
delegate reads and the key material the engine recorded from diverging.

The guarantee costs one traversal per descriptor per `refresh`, through a
single identity map, over metadata the scan already parsed. That traversal
reads no file and loads no body, so a refresh costs what a scan costs, one
read, hash, and frontmatter parse per flow, plus one copy of what that parse
produced. The single map is also what keeps a value two fields reference from
coming back as two objects.

## Reading it back

- [Sources and naming](./sources.md): where descriptors come from and how they
  get their names.
- [Delegation](./delegation.md): how a descriptor becomes something the engine
  can run.
- [API reference](../api.md): every field, schema, and constructor.
