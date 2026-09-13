---
title: "Installation"
description: "Install @smthrs/core, its runtime requirements, its import forms, and the subpaths that are not part of the public surface."
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add @smthrs/core@next effect@4.0.0-rc.115
```

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has no platform bindings: it reads no
file, opens no socket, and starts no process, so the same build runs in Node,
in Bun, in a browser, and in a Cloudflare Worker.

The package requires `effect@4.0.0-rc.115` as an exact peer dependency. Keep
the application on that version so all Smithers packages share one Effect
runtime. [`effect`](https://effect.website) supplies `Schema`, `Context`,
`Result`, and `Data`, which appear in this package's public types. Import it
directly in your own code.

Three runtime dependencies install with it:

- [`@smthrs/canonical`](/api/canonical) supplies the RFC 8785 canonical JSON
  serialization behind `Digest.canonical`.
- [`@smthrs/crypto`](/api/crypto) supplies the synchronous SHA-256 behind
  `Digest.digest` and behind captured function identity.
- [`yaml`](https://eemeli.org/yaml/) parses Agent Skills frontmatter with the
  failsafe schema.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Effects, Flow, Graph, Markdown, Node, Placement } from "@smthrs/core"
```

Each module is also importable from its own subpath, which is the form this
package's consumers use and the form the API reference uses in its examples:

```ts
import * as Digest from "@smthrs/core/Digest"
import * as Flow from "@smthrs/core/Flow"
```

Both forms resolve to the same module. Prefer the subpath form when you import
one or two modules into a large file, because it keeps the namespace name in
the import specifier where a reader can see it.

## What is not public

Two subpath families are blocked in the package's export map and are not part
of the contract:

- `@smthrs/core/internal/*` holds the AST representation, the effect path
  index, and the frontmatter splitter. Their shapes change without a version
  bump.
- `@smthrs/core/*/index` is blocked so a deep import cannot reach a module's
  barrel by a second name.

`@smthrs/core/package.json` is exported.

## What a real composition adds

`@smthrs/core` on its own gets you declarations, a planned graph, and key
material. It does not execute anything. A host that runs what the plan
describes adds the packages above it:

- [`@smthrs/plan`](/api/plan) compiles key material into step keys, performing
  the dependency-digest substitution this package deliberately leaves undone.
- [`@smthrs/registry`](/api/registry) resolves the flow names a declaration
  carries, and owns the markdown and Agent Skills rules that need the file
  system.
- [`@smthrs/harness`](/api/harness) reads effects, placement, and key material
  at its durable boundary.
- [`@smthrs/agent`](/api/agent) runs the agent loop those declarations describe.

For unit tests of a package that builds nodes, nothing else is needed:
`TestRuntime` runs the deferred callbacks in memory. See
[Test a declaration without a host](./guides/test-a-declaration.md).

## Next step

Plan your first graph in the [Quickstart](./quickstart.md).
