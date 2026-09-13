---
title: "Detect an error across module copies"
description: "Choose between isSmithersError and hasSmithersErrorShape: when instanceof is enough, when a structural check is required, and what each refinement refuses."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/guides/detect-an-error-across-module-copies.md"
---

The package ships two refinements for the same question, and they answer it
differently on purpose.

```ts
import { hasSmithersErrorShape, isSmithersError } from "@smthrs/errors"
```

## Use isSmithersError by default

`isSmithersError` is `value instanceof SmithersError` and nothing else. It is
exact, it accepts every subclass, and it cannot be forged by an object that
merely looks right:

```ts
isSmithersError(new SmithersError("INVALID_INPUT", "x")) // true
isSmithersError(new Subclass("INVALID_INPUT", "x")) // true
isSmithersError(new Error("plain")) // false

const forged = new Error("forged")
forged.name = "SmithersError"
isSmithersError(forged) // false
```

Use it when the error was raised by code that resolves the same copy of
`@smthrs/errors` through the same module format you did, which is the normal
case inside one build.

## Use hasSmithersErrorShape across a boundary

`instanceof` compares prototypes, so it answers `false` for an error built by a
second copy of the package: a duplicated dependency, a bundled build beside a
source build, or a plugin loaded from its own `node_modules`. Mixed
ESM/CommonJS loading is also a module-copy boundary: the published entry
points expose the same API with distinct constructors, even with one installed
package version.

In a Node.js ESM consumer of the published package:

```ts
import { hasSmithersErrorShape, isSmithersError } from "@smthrs/errors"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const cjs = require("@smthrs/errors")
const error = new cjs.SmithersError("INVALID_INPUT", "x")

isSmithersError(error) // false, the CommonJS constructor is distinct
hasSmithersErrorShape(error) // true
```

The same applies when a CommonJS consumer checks an error from the ESM entry
point. Deduplicating installed versions does not remove this boundary.

`hasSmithersErrorShape` asks the structural question instead. The value must:

- be an `Error`,
- carry a `code` that `isSmithersErrorCode` accepts, so a string outside the
  five documented codes is refused,
- carry `summary` and `docsUrl` as strings,
- carry `details` that is either absent or a non-null, non-array object.

```ts
const error = new SmithersError("INVALID_INPUT", "x")
Object.setPrototypeOf(error, Object.getPrototypeOf(new Error()))

isSmithersError(error) // false, the prototype is gone
hasSmithersErrorShape(error) // true, every field still checks out
```

It narrows to `SmithersError`, and `error.code` narrows to
`SmithersErrorCode`, so a `switch` after it is exhaustive even though the value
came from outside.

## What the structural check still refuses

The check is stricter than a `name` comparison, which is the point:

```ts
hasSmithersErrorShape(new Error("plain")) // false, no code
hasSmithersErrorShape({ code: "INVALID_INPUT", summary: "x", docsUrl: "u" }) // false, not an Error
hasSmithersErrorShape(Object.assign(new Error("f"), { code: "NOT_A_CODE", summary: "s", docsUrl: "u" })) // false
hasSmithersErrorShape(Object.assign(new Error("f"), { code: "INVALID_INPUT" })) // false, incomplete
```

A `details` value that is a string, `null`, a number, or an array is refused
too. Every one of those would break a caller that spreads or reads keys from
`details`.

Inspecting a value runs caller code, so every read is inside a `try` and an
inspection that throws answers `false`:

```ts
const hostile = Object.assign(new Error("f"), { code: "INVALID_INPUT", summary: "s", docsUrl: "d" })
Object.defineProperty(hostile, "code", {
  get() {
    throw new Error("boom")
  }
})

hasSmithersErrorShape(hostile) // false, and no exception escapes
```

The same holds for a revoked proxy and for a proxy whose prototype lookup
throws. This is what keeps the refinement usable in a `catch`: one that threw
would replace the failure being classified with the accessor's error.

What it cannot refuse is a deliberate forgery: a plain `Error` with all four
fields set correctly passes. The refinement answers "this value is safe to
read as a `SmithersError`", not "this value was raised by Smithers". Use it on
values from a module boundary you trust, not on values from a network.

## Build the same pair for your subclass

A subclass refinement combines both, because neither is sufficient alone:
`instanceof` misses the cross-copy instance, and a `name` check accepts a
forgery. Check the class or the name, then the structure, then the extra
fields your own conversions read. Wrap the whole refinement in a `try` the way
`hasSmithersErrorShape` does, because the extra fields you read are caller code
too and an inspection that throws must answer `false`.
`Core.IntegrationError.isIntegrationError` in
[`@smthrs/integrations`](https://integrations.smithers.sh/reference/api/) is the worked example, and
[Raise a SmithersError from an adapter](/guides/raise-an-error/#ship-a-refinement-with-the-subclass)
walks through it.
