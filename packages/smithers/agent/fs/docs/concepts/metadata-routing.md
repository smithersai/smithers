---
title: "Metadata routing"
description: "How @smthrs/fs turns a flows directory into immutable, path-named routes without importing any flow module."
sidebar:
  order: 1
---

Metadata routing is the discovery half of `@smthrs/fs`: a flows directory
becomes a set of immutable routes without a single flow module being
imported. Understanding why discovery avoids imports, and where route names
come from, explains every surface the package projects later.

## Scanning never runs user code

Listing available commands must not execute them. If learning a flow's name
required importing its module, every scan would run arbitrary user code and
pay the cost of every dependency in the tree. So the scan is metadata-only:
the [registry](/api/registry) reads entries statically, owning entry
precedence, metadata parsing, directive detection, and bounded reads, and
`FileRouter.scan` projects the resulting descriptors into routes.
`Command.list` reads that same metadata and imports nothing.

The proof is in the failure modes. A flow whose module throws at import time
still scans: the route appears in `ScanResult.routes` because the module body
never ran. Beyond scan and list, imports are deliberate and narrow. A
dispatch imports only the one module its command names. The first Incur help,
OpenAPI, or MCP discovery imports every visible module once, because
publishing each flow's real input schema requires loading it, and caches the
projection for the lifetime of the CLI.

## Route identity comes from paths

A route's name is its directory path relative to the scan root, joined with
slashes: `flows/review/flow.ts` under root `flows` becomes the route
`review`, and `flows/domains/list/flow.ts` becomes `domains/list`. The flow's
own `name` field is ignored; the registry emits a `name_field_ignored`
warning when one is declared. Root-level entries produce no route at all.

Because names are paths, the package defends their meaning across platforms
and encodings:

- Segmentation uses the active path separator, so a literal backslash in a
  POSIX directory name stays inside one segment instead of inventing nesting.
- Segments and names are canonicalized to Unicode NFC at snapshot time, and
  lookup normalizes only the lookup key, so a decomposed directory name from
  the filesystem and a composed name from a browser select the same route.
- Source paths are absolute, and module loading encodes them through the
  registry's file-specifier encoder, so spaces, percent signs, hashes, and
  query characters name the file rather than URL structure.

`Route.snapshot` freezes this identity: `name` must equal
`segments.join("/")` after normalization, and every other field is validated
against the same immutable contract. Anything caller-owned is detached and
frozen before the first asynchronous boundary, so later mutation cannot reach
an in-flight operation. The normative details live in the
[filesystem routing contract](../contract.md).

## Kinds and visibility decide executability

Every discovered entry becomes a route, but not every route is executable:

- `kind` records how the body is stored: `module` for a flow module, `skill`
  for a `SKILL.md` body, and `markdown` for every other body.
- `modelInvocable` records whether the flow declared itself callable by a
  model.

`Route.isCommandRoute` is the single guard both execution surfaces apply:
kind `module` with `modelInvocable` true. `Command.make` and
`Incur.createCli` filter to those routes; `Route.load` refuses every other
body kind with `unsupported_body`, because `@smthrs/fs` executes module bodies
only. Markdown and skill routes still appear in
scan results, so tooling can inspect the whole tree even though it cannot
run every member of it.

## The trie is the shared resolution vocabulary

`CommandTree` indexes routes by segment so that every projection resolves
names the same way. Two lookups exist because two callers exist:

- `resolve` takes the longest routable prefix of an argv and returns the
  unconsumed remainder, which is how a command string like
  `review --number 42` splits into a route and its arguments.
- `resolveExact` demands a complete match, which is how a programmatic
  `call` refuses a typo or a trailing segment with `unknown_command`.

A node may carry a route and children at once, so `domains` and
`domains/list` coexist. Two routes claiming the same segment path fail
`CommandTree.make` with `duplicate_route` instead of silently shadowing each
other.

## Placement is metadata, not execution

A leading directive such as `"use client"` or `"use sandbox"` in a flow's
source is normalized by the registry into a placement literal and carried on
the route's `placement` field. `Directive.compile` lowers that literal to the
corresponding [core](/api/core) `Placement` value when a consumer needs one.
This package records where a flow is declared to run; choosing an execution
environment belongs to the harness behind
[the `FlowInvoker` seam](./command-projections.md).

## Where to go next

- [Command projections](./command-projections.md): how these routes become schema-checked surfaces.
- [Quickstart](../quickstart.md): scan a real tree and inspect the routes.
- [Filesystem routing contract](../contract.md): the normative path, snapshot, and resource rules.
