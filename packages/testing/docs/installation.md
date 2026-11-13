---
title: "Installation"
description: "Install @smthrs/testing, its optional vitest peers, its import forms, and the subpaths that are deliberately not on the root barrel."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/testing@next effect
```

The `next` tag carries the 1.0 release candidates.

[`effect`](https://effect.website) is a required peer dependency in the version
`4.1.1`. Two copies of `effect` in one program are two sets of service
tags, so the package takes `effect` from your project and never installs its
own.

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. The `@smthrs/*` packages the assertions
read install with it: [`@smthrs/core`](/api/core),
[`@smthrs/engine`](/api/engine), [`@smthrs/flow`](/api/flow),
[`@smthrs/jj`](/api/jj), [`@smthrs/journal`](/api/journal),
[`@smthrs/kernel`](/api/kernel), [`@smthrs/model`](/api/model), and
[`@smthrs/plan`](/api/plan). The grading facade also installs
[`@smthrs/scorers`](/api/scorers), which owns the runner-neutral `ScoreGate`
implementation. Evals consumes scorers directly and needs no testing facade
in production.

## Install the vitest peers only if you use the adapter

`vitest` and `@effect/vitest` are optional peer dependencies. Only the
`Vitest` module imports them. The adapter peer selects the tested release:

```bash
npm install --save-dev vitest@5.0.0 @effect/vitest@4.1.1
```

Every other module works under any runner, because an assertion is an ordinary
`Effect` and a conformance case is a plain value.

## Import forms

The root entry point re-exports module namespaces:

```ts
import { Conformance, EngineSubject, JournalAssertions, TestLayers } from "@smthrs/testing"
```

Many modules are also importable from a declared subpath, which is the form
the [API reference](./api.md) uses. Import `RealCliDriver` and
`TerminalRecording` from the root:

```ts
import { RealCliDriver, TerminalRecording } from "@smthrs/testing"
import * as JournalAssertions from "@smthrs/testing/JournalAssertions"
import * as TestLayers from "@smthrs/testing/TestLayers"
```

The root barrel requires a Node-capable host: `HttpRecording` and `FuzzCorpus` import Node filesystem and crypto modules. Keeping the modules
below on explicit subpaths does not make the root import browser-portable.

## Seven modules stay off the root barrel

`TestHost` is the deterministic host bundle: an in-memory filesystem, scripted
interpreter, `TestClock`, and seeded PRNG. Each layer build starts with a fresh
filesystem containing `/tmp` and restarts the PRNG from its seed, even when
tests reuse the exported `TestHost.TestHost` layer. Import it explicitly:

```ts
import * as TestHost from "@smthrs/testing/TestHost"
```

The scripted interpreter only runs commands declared as own properties of the
command table. An unlisted command returns exit code `127` and
`command not found: <command>\n` on stderr, including names such as `constructor`
and `__proto__`.

The memory filesystem places files the way a disk does. A write fails with
`ENOENT` when its parent directory is missing, `ENOTDIR` when a parent is a
file, and `EISDIR` when the path is a directory; only the files seeded through
`files` get their parent directories created for them. The write `flag` is
honoured: `a` and `a+` append, `wx`, `ax`, and their `+` forms fail with
`EEXIST` when the file exists, `w` and `w+` truncate, and any other flag is
refused as an invalid argument rather than treated as a truncating write.
Non-recursive `mkdir` rejects with `EEXIST` when the path exists, `ENOENT`
when its parent is missing, and `ENOTDIR` when its parent is a file; recursive
`mkdir` rejects a file in its way with `ENOTDIR` (`EEXIST` when the file is
the final segment). Listing a file as a directory fails with `ENOTDIR`. Host
conformance reserves its scratch directory with non-recursive `mkdir`, refusing
collisions before writing its probe file, then holds the bundle to the append,
exclusive-create, and placement rules above. Non-recursive `rm` rejects a
non-empty directory with `ENOTEMPTY`, including when `force` is set, and
preserves its entries. Use `recursive: true` to create missing parents or
remove a directory tree.

`Vitest` is ESM only and absent from the barrel on purpose. `vitest` refuses to
load through `require()`, so a barrel that re-exported it would break
`require("@smthrs/testing")` for every CommonJS consumer of the assertion
helpers:

```ts
import * as Vitest from "@smthrs/testing/Vitest"
```

`Faults` is absent for a different reason: it is not a double. It sends real
signals to real pids and moves the wall clock this process reads. Importing it
by subpath keeps that decision visible at the import site:

```ts
import { killProcess, waitForReparent } from "@smthrs/testing/Faults"
```

The root entry is not yet portable to browser or Worker test hosts:
`HttpRecording` imports filesystem and path modules, database test layers reach
Node adapters, and filesystem corpus tools also use Node modules. Keeping the
host helpers below on subpaths does not remove those root dependencies.
`FixtureStore.makeMemory` and `layerMemory` themselves need no host services;
`makeFile` and `layerFile` require injected filesystem and path services.

`ProcessTable` is absent because it spawns `ps` through `node:child_process`,
which browser test hosts cannot load:

```ts
import * as ProcessTable from "@smthrs/testing/ProcessTable"
```

`ModelServer`, `ModelServerCli` and `TurnLog` are absent because they listen
through `node:http` or write files through `node:fs`:

```ts
import * as ModelServer from "@smthrs/testing/ModelServer"
import * as ModelServerCli from "@smthrs/testing/ModelServerCli"
import * as TurnLog from "@smthrs/testing/TurnLog"
```

The package also installs the `smthrs-model-server` command. See
[Serve a recorded model over HTTP](./guides/serve-a-recorded-model.md).

## What is not public

`@smthrs/testing/internal/*` and `@smthrs/testing/*/index` are blocked in the
package's export map. `@smthrs/testing/package.json` is exported.

## Next step

Certify an engine against the mandatory conformance suite in the
[Quickstart](./quickstart.md).
