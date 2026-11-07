---
title: "Installation"
description: "Install @smthrs/model from npm, plus its runtime requirements and import forms."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/model@next effect
```

The `next` tag carries the 1.0 release candidates.

## Requirements

- Node.js 22.19.0 or later, from the package's `engines` field.
- `effect` `4.1.1`, declared as a peer dependency. Routes, streams, and
  layers are all `Effect` values, so your package installs `effect` itself.
- `@smthrs/capability` and `@smthrs/kernel` come along as dependencies of this
  package. You do not import them to make a call.

## Import forms

Import from the root entry point. It re-exports every module as a namespace:

```ts
import { Model, ModelEvent, ModelRequest, Route } from "@smthrs/model"
```

Each module is also exported on its own subpath, such as
`@smthrs/model/Route`, for code that imported it that way before. New code
imports the root.

Two subpath forms are blocked on purpose: `@smthrs/model/internal/*` and any
nested `*/index`. `@smthrs/model/package.json` is exported for tooling that
needs the version.

## What a running route needs

A configured route executes through `RequestExecutor`, and the executor needs
an Effect `HttpClient`. `FetchHttpClient.layer` from `effect` is the plain
one, and the [quickstart](./quickstart.md) builds the whole layer graph with
it.

Inside a Smithers run the kernel composes its permission middleware over that
client, which checks a `model:call` capability for the target host and model
before any bytes leave the process. That check is what raises
`PermissionRequired` and `PermissionDenied` instead of a `ModelError`; see the
[kernel API](/api/kernel) for the contract and
[Handle failures](./guides/handle-failures.md) for how to branch on it.
