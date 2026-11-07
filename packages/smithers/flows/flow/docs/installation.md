---
title: "Installation"
description: "Install @smthrs/flow from npm, its runtime requirements and effect range, its import forms, and the packages a runnable composition adds."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/flow@next effect
```

The `next` tag carries the 1.0 release candidates.

`effect` is a peer dependency of this package, at exactly `4.1.1`. Add one
`effect` at that version to your own dependencies: your declarations import
`effect/Schema` and your implementations import `effect/Effect` directly, and two
copies of `effect` in one program are two sets of service tags.

The package requires Node.js 22.19.0 or later. It ships as both ESM and
CommonJS with TypeScript declarations, and it pulls in
[`@smthrs/plan`](/api/plan), [`@smthrs/crypto`](/api/crypto),
[`@smthrs/keys`](/api/keys), and [`@smthrs/canonical`](/api/canonical), which
supply the node vocabulary a body is written in, the digests identity is built
from, and the canonical JSON checks applied to values.

## Use the libraries

Every `@smthrs` library installs from npm the same way. Name each package your
code imports with the `next` tag, and add one `effect` in the `4.1.1` range
the libraries peer. The [Quickstart](./quickstart.md) program needs these:

```bash
npm install @smthrs/flow@next @smthrs/engine@next @smthrs/plan@next @effect/platform-node effect
```

`next` resolves every `@smthrs` package to the same release candidate. With
pnpm 11, name that version instead of the tag; the
[Flows installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/installation.md)
explains why.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Action, DurableDeferred, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
```

Several modules are also importable from their own subpath, which is the form the
reference uses:

```ts
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as Flow from "@smthrs/flow/Flow"
```

The `exports` map publishes `@smthrs/flow/Action`, `/CacheEnvironment`,
`/FileBoundary`, `/FileInput`, `/Flow`, `/FlowRuntime`, `/StepIdentity`, and one
subpath per top-level module (`DurableClock`, `DurableDeferred`, `DurableQueue`,
`Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`, `WaitFor`).
Four subpath shapes resolve to nothing on purpose: `@smthrs/flow/internal/*`,
`@smthrs/flow/*/index`, and the per-file paths under `Action/`, `Flow/`, and
`FlowRuntime/`. Reach those namespaces through their directory subpath instead.
`@smthrs/flow/package.json` is exported.

## What a runnable composition adds

This package declares the `FlowRuntime` port and implements none of it, so a
composition that runs a flow adds an engine and a platform crypto service.

- [`@smthrs/engine`](/api/engine) implements `FlowRuntime`. Its
  `FlowEngine.layerMemory` keeps every recorded step in the process, which is
  what the [Quickstart](./quickstart.md) and most tests use.
- `@effect/platform-node` supplies `NodeCrypto.layer`. An action dispatch is
  recorded under a derived step identity, so the engine needs a `Crypto` service
  even in memory. A browser host supplies its own, such as `BrowserCrypto` from
  `@effect/platform-browser`; nothing in this package imports a Node built-in.

Add [`@smthrs/engine-store`](/api/engine-store) when the recorded steps have to
outlive the process. It backs the same port with SQLite, which is what turns a
suspended run into one a later process resumes.

## Next step

Run a flow end to end in the [Quickstart](./quickstart.md).
