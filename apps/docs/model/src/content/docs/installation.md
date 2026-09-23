---
title: "Installation"
description: "Add @smthrs/model to a workspace package, plus its runtime requirements and import forms."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/installation.md"
---

`@smthrs/model` is at 1.0.0-rc.0 and is not on the npm registry yet, so
`npm install @smthrs/model` finds nothing. It is a workspace package of the
[Smithers repository](https://github.com/smithersai/smithers), and you use it
from a package in that workspace.

## Get the workspace

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

## Add it to a workspace package

Declare a workspace dependency from the package that calls a model:

```json
{
  "dependencies": {
    "@smthrs/model": "workspace:*"
  }
}
```

Then install again:

```bash
pnpm install
```

## Requirements

- Node.js 26.4.0 or later, from the package's `engines` field.
- `effect` 4.0.0-rc.115, declared as a peer dependency. Routes, streams, and
  layers are all `Effect` values, so your package installs `effect` itself.
- `@smthrs/capability` and `@smthrs/kernel` come along as dependencies of this
  package. You do not import them to make a call.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Model, ModelEvent, ModelRequest, Route } from "@smthrs/model"
```

Every namespace is also importable on its own subpath, which keeps type
resolution narrow in large projects:

```ts
import * as Route from "@smthrs/model/Route"
```

Two subpath forms are blocked on purpose: `@smthrs/model/internal/*` and any
nested `*/index`. `@smthrs/model/package.json` is exported for tooling that
needs the version.

## What a running route needs

A configured route executes through `RequestExecutor`, and the executor needs
an Effect `HttpClient`. `FetchHttpClient.layer` from `effect` is the plain
one, and the [quickstart](/quickstart/) builds the whole layer graph with
it.

Inside a Smithers run the kernel composes its permission middleware over that
client, which checks a `model:call` capability for the target host and model
before any bytes leave the process. That check is what raises
`PermissionRequired` and `PermissionDenied` instead of a `ModelError`; see the
[kernel API](https://kernel.smithers.sh/reference/api/) for the contract and
[Handle failures](/guides/handle-failures/) for how to branch on it.
