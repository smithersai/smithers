/* Sample content for the repo app mock. Real files and real recent changes, trimmed. */
import type { Site } from "../core/router"

export interface FileRow { name: string; kind: "dir" | "file"; note: string; age: string }
export interface RepoFile { content: string; lang: "ts" | "md" | "json" | "sh" | "txt" }

export interface IssueComment { who: "maya" | "will" | "cora" | "bot"; text: string; when: string }
export interface Receipt {
  stage: "reported" | "accepted" | "working" | "review" | "merged"
  reporter: string
  reported: string
  acceptedBy?: string
  accepted?: string
  run?: string
  pull?: number
  commit?: string
  agent?: string
}
export interface Issue {
  n: number
  title: string
  state: "open" | "closed"
  labels: string[]
  author: "maya" | "will" | "cora"
  opened: string
  body: string
  comments: IssueComment[]
  receipt?: Receipt
}

export interface DiffLine { kind: "ctx" | "add" | "del" | "hunk"; text: string; old?: number; new?: number }
export interface DiffFile { path: string; lines: DiffLine[] }
export interface Pull {
  n: number
  title: string
  state: "open" | "merged"
  branch: string
  forWho: string
  opened: string
  fixes?: number
  commit: { sha: string; subject: string }
  checks: Array<{ name: string; ok: boolean; detail: string; error?: string }>
  additions: number
  deletions: number
  summary: string
  findings: Array<{ file: string; line: number; text: string }>
  diff: DiffFile[]
  mergedSha?: string
}

export interface Stage { label: string; summary: string; log: string[]; duration: string }
export interface Run {
  id: string
  title: string
  agent: string
  started: string
  status: "running" | "needs-you" | "refused" | "failed" | "done"
  activeStage: number
  stages: Stage[]
}

export interface Answer {
  q: string
  disclosure: string
  files: Array<{ path: string; label: string }>
  md: string
  openOwn?: boolean
}

export interface FixedPair { date: string; issue: number; title: string; sha: string; agent: string }

export interface RepoData {
  slug: string
  site: Site
  description: string
  license: string
  github: string | null
  mirrorOf?: string
  lastChange: string
  text: string
  askTitle: string
  askPlaceholder: string
  visitorChips: string[]
  memberChips: string[]
  links: Array<{ label: string; route?: string; href?: string; card?: "bug"; needsConverter?: boolean }>
  fixed: FixedPair[]
  tree: Record<string, FileRow[]>
  dirReadmes: Record<string, string>
  files: Record<string, RepoFile>
  readme: string
  issues: Issue[]
  pulls: Pull[]
  runs: Run[]
  answers: Answer[]
  memberButtons: boolean
}

const SMITHERS_README = `Smithers runs coding agents on your repo. You review the diff and merge it yourself.

## Open Smithers

Open [the Smithers repository](smithers.sh/smithers-canary/smithers) in your browser.
Explore its files, ask for work in chat, and inspect runs and changes in the conversation.
Sign in with GitHub when you are ready to contribute.

For local execution and authoring, use the CLI and libraries described below.

## Supported platforms

The release candidate's required platform is Linux with Node 26.4.0.

## Install

The libraries install from npm. Install the CLI from npm:

\`\`\`bash
npm install -g smthrs@next
\`\`\`

## Get started

Run these commands from your project directory. Before launching, edit the
scaffolded flow and configure the credential its \`model:\` field requires. The
[CLI quickstart](smithers.sh/docs) covers each step.

\`\`\`bash
smthrs init change
smthrs flow start change
\`\`\`

## Documentation

Read the [Smithers documentation](smithers.sh/docs) for tutorials, guides, and the full reference.

## Contributing

See [CONTRIBUTING.md](https://github.com/smithersai/smithers/blob/main/CONTRIBUTING.md) for local setup, testing, and pull request guidance.

## License

Smithers is MIT licensed. See [LICENSE](smithers.sh/smithers-canary/smithers/blob/main/LICENSE) for details.`

const SMITHERS_PACKAGE_JSON = `{
  "name": "smithers",
  "description": "Smithers runs coding agents on your repo. You review the diff and merge it yourself.",
  "author": "William Cory",
  "license": "MIT",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/smithersai/smithers.git"
  },
  "homepage": "https://github.com/smithersai/smithers#readme",
  "bugs": {
    "url": "https://github.com/smithersai/smithers/issues"
  },
  "packageManager": "pnpm@11.25.0",
  "scripts": {
    "commit": "node .smithers/flows/land/commit.mjs",
    "dev": "pnpm --filter smithers-app run start",
    "deploy": "pnpm --filter smithers-server run deploy",
    "check": "pnpm --recursive --if-present run check",
    "lint": "pnpm --recursive --if-present run lint",
    "test": "pnpm --recursive --if-present run test",
    "test:e2e": "pnpm --filter smithers-app run test:e2e"
  },
  "engines": {
    "node": ">=26.4.0",
    "bun": ">=1.4.0"
  }
}`

const LICENSE = `MIT License

Copyright (c) 2026 Smithers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`

const REPOSITORY_HOME_TS = `/**
 * The server-resolved homepage of a repository at main.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { HttpUrlSchema } from "./WebUrl.ts"

const title = z.string().min(1).max(120)
const flow = z.string().regex(/^[a-z0-9_-]+(?:[./][a-z0-9_-]+)*$/)
const path = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\\\") &&
  !/[%:?#\\x00-\\x1f]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
)

const prompt = z.object({
  type: z.literal("prompt"),
  flow: flow.optional(),
  title: title.optional(),
  placeholder: title.optional()
})
/* An app: a featured flow with a picture (D-18); the tiles of the app home. */
const app = z.object({ type: z.literal("app"), flow, title, picture: z.enum(["issue", "review", "wiki", "schedule"]) })
const flows = z.object({ type: z.literal("flows"), title: title.optional() })
const markdown = z.object({
  type: z.literal("markdown"),
  path,
  title: title.optional(),
  markdown: z.string().max(256 * 1024)
})
const text = z.object({ type: z.literal("text"), title: title.optional(), text: z.string().min(1).max(4096) })
/* The repository's live mythical stack; the app reads it from \`@smthrs/rpc/Mythical\`. */
const stack = z.object({ type: z.literal("stack"), title: title.optional() })
const links = z.object({
  type: z.literal("links"),
  title: title.optional(),
  links: z.array(z.object({
    label: title,
    url: HttpUrlSchema
  })).min(1)
})
/* A repository flow's declared view, drawn in this place (\`Smithers.Home.View\`). */
const view = z.object({ type: z.literal("view"), flow })

/** One homepage block after the server resolves markdown content.
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryHomeBlockSchema = z.discriminatedUnion("type", [
  prompt,
  app,
  flows,
  markdown,
  text,
  stack,
  links,
  view
])

/** The homepage resolution result at main.
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryHomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blocks"), blocks: z.array(RepositoryHomeBlockSchema).max(32) }),
  z.object({ kind: z.literal("readme"), markdown: z.string().max(256 * 1024) }),
  z.object({ kind: z.literal("none") })
])
/** The homepage resolution result at main.
 * @category models
 * @since 1.0.0
 */
export type RepositoryHome = z.infer<typeof RepositoryHomeSchema>`

const RUNTIME_TS = `/**
 * Platform-independent composition for the durable flows runtime.
 *
 * The SQL client and host services are injected. No driver is opened here;
 * native entrypoints compose their matching database and platform layers.
 *
 * Construction is ordered by layer dependencies: the SQLite parent directory
 * is created before the database opens, migrations finish before any store is
 * built, the durable engine is built over those stores, and \`registerFlows\`
 * finishes before the resulting services are exposed. The engine's own
 * registration hook then re-arms durable clocks and deferred wakes, so a
 * persisted run cannot resume through this composition before its flow has
 * been registered.
 *
 * @since 0.1.0
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { DurableWriter } from "@smthrs/database"
import {
  DurableEngineState,
  EngineStore,
  OwnerIdentity,
  type StepBoundary,
  type WorkspaceSandbox
} from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { Action } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Workspace from "@smthrs/kernel/Workspace"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { type RegistryArgs, registryLayer } from "./internal/RegistryArgs.ts"

export { type Options, RuntimeConfigurationError } from "./internal/RuntimeOptions.ts"
import { decodeField, type Options, validate } from "./internal/RuntimeOptions.ts"

const nonEmpty = "must be a non-empty string"

/**
 * Provides the migrated database, durable stores, owner minter, workspace,
 * and local artifact store without constructing an engine.
 *
 * This is the lower-level seam for integrations that construct another
 * engine-backed service over the same storage context, such as the time-travel
 * example. Application entry points should normally use {@link layer}.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const storage = (filename: string, workspaceRoot?: string) => {
  const configuredFilename = decodeField("filename", Schema.NonEmptyString, filename, nonEmpty)
  const configuredRoot = workspaceRoot === undefined
    ? undefined
    : decodeField("workspaceRoot", Schema.NonEmptyString, workspaceRoot, nonEmpty)
  return Layer.unwrap(Effect.gen(function*() {
    const path = yield* Path.Path
    const databaseRoot = /^postgres(?:ql)?:\\/\\//.test(configuredFilename)
      ? path.join(path.resolve(configuredRoot ?? "."), ".flows")
      : path.dirname(path.resolve(configuredFilename))
    const resolvedWorkspaceRoot = configuredRoot === undefined ? databaseRoot : path.resolve(configuredRoot)
    const database = Layer.provideMerge(Migrations.layer, DurableWriter.layer())
    return Layer.mergeAll(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
      RunStore.layer,
      AttemptStore.layer,
      CacheStore.layer,
      DurableEngineState.layer,
      OwnerIdentity.layer,
      Workspace.layer(resolvedWorkspaceRoot),
      ArtifactStore.layerFileSystem({ directory: path.join(databaseRoot, "objects") })
    ).pipe(Layer.provideMerge(database))
  })).pipe(Layer.fresh)
}

/** Compose an isolated runtime from injected storage and execution services.
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
) => {
  const validated = validate(options)
  const execution = Layer.merge(stepBoundary, workspaceSandbox).pipe(
    Layer.provideMerge(storage(validated.filename, validated.workspaceRoot)),
    Layer.provideMerge(RedactedLogger.layer())
  )
  const engineOptions: EngineStore.Options = {
    owner: validated.owner,
    journalSource: \`\${validated.owner.hostId}-engine\`,
    isAlive: validated.isAlive,
    canExecute: validated.canExecute,
    canActivate: validated.canActivate,
    requestResume: validated.requestResume,
    sourceRevision: validated.sourceRevision
  }
  const engine = (validated.privilegedJj === undefined
    ? EngineStore.layer(engineOptions)
    : EngineStore.layerWithPrivilegedJj(engineOptions, validated.privilegedJj)).pipe(
      Layer.provideMerge(execution),
      Layer.provideMerge(
        validated.cacheEnvironment === undefined
          ? Layer.empty
          : Action.layerCacheEnvironment(validated.cacheEnvironment)
      )
    )
  return Layer.effectContext(Layer.build(
    registerFlows.pipe(Layer.provideMerge(registryLayer(registry)), Layer.provideMerge(engine), Layer.fresh)
  ))
}`

const NODE_RUNTIME_TS = `/** Node host composition over the shared, injected durable runtime.
 * @since 1.0.0
 */

import * as Database from "@smthrs/database/node/NodeDatabase"
import * as Host from "@smthrs/platform-node/NodeHost"
import { makeNative } from "./internal/NativeRuntime.ts"
import type { NativeRuntimeApi } from "./internal/NativeRuntimeApi.ts"

export type { HostOptions } from "./internal/NativeRuntime.ts"
export { RuntimeConfigurationError } from "./Runtime.ts"
export type { Options } from "./Runtime.ts"

const runtime = makeNative({
  name: "NodeRuntime",
  database: (filename) => Database.layer({ filename }),
  host: Host,
  crypto: Host.NodeCrypto.layer
})

/** Provides the migrated stores over the native SQL driver.
 * @since 1.0.0
 * @category layers
 */
export const storage: NativeRuntimeApi["storage"] = runtime.storage
/** Builds the shared durable runtime in the caller’s Effect scope.
 * @since 1.0.0
 * @category layers
 */
export const make: NativeRuntimeApi["make"] = runtime.make
/** Provides the shared runtime with an explicitly supplied execution boundary.
 * @since 1.0.0
 * @category layers
 */
export const layer: NativeRuntimeApi["layer"] = runtime.layer
/** Provides the native host, guarded services, database and registered flows.
 * @since 1.0.0
 * @category layers
 */
export const layerHost: NativeRuntimeApi["layerHost"] = runtime.layerHost
/** Returns the conventional exit code for a native shutdown signal.
 * @since 1.0.0
 * @category layers
 */
export const signalExitCode: NativeRuntimeApi["signalExitCode"] = runtime.signalExitCode
/** Default graceful-shutdown deadline in milliseconds.
 * @since 1.0.0
 * @category layers
 */
export const defaultShutdownTimeoutMs: NativeRuntimeApi["defaultShutdownTimeoutMs"] = runtime.defaultShutdownTimeoutMs
/** Largest supported native shutdown timer delay.
 * @since 1.0.0
 * @category layers
 */
export const maximumShutdownTimeoutMs: NativeRuntimeApi["maximumShutdownTimeoutMs"] = runtime.maximumShutdownTimeoutMs`

const EFFECK_README = `# VibeLang

A language for building reliable TypeScript in the AI era, built on [Effect](https://effect.website). VibeLang gives Effect a simple, readable syntax that compiles to TypeScript, with first-class access to the TypeScript ecosystem.

> VibeLang is v0. The language will change in major, breaking ways. It is not suitable for production use.

Docs: [effeck.dev](effeck.dev/), with the guides and, under [effeck.dev/spec/](effeck.dev/), the specification.

## A short tour

\`\`\`ts
error NotFound { id: string }

interface User { id: string; name: string }

service Users {
  find(id: string): User!NotFound
}

const UsersLive = Layer.succeed(Users, {
  find(id) {
    if (id !== "42") throw new NotFound({ id })
    return { id, name: "Ada" }
  }
})

function greet(id: string) {
  return \`Welcome, \${Users.find(id).name}\` catch (e) => \`No user \${e.id}\`
}

export function main() {
  provide UsersLive {
    const [ada, missing] = await.all [greet("42"), greet("7")]
    const first = await.race [greet("42"), do { sleep("1 second"); "timeout" }]
    const shout = ada |> %.toUpperCase()
    Console.log(shout, missing, first)
  }
}
\`\`\`

Every function is an Effect: \`greet\` has the contract \`string!!Users\` (no expected failures, because \`catch\` handles \`NotFound\`). Calls run where they stand, \`throw\` fails with a typed error, \`provide\` supplies a layer, and \`await.all\` and \`await.race\` run programs concurrently.

## Quickstart

\`\`\`sh
bun create vibelang my-app
cd my-app
bun run start
bun run test
\`\`\`

With npm, run \`npm create vibelang@latest my-app\`. You need Node 26 or later and
Bun 1.4 or later. The command copies a starter, pins \`vibelang\`,
\`vibelang-runtime\`, and \`vibelang-vite\` to one version, and installs dependencies;
\`--no-install\` skips installation. The compiler is a native binary from a
per-platform package for macOS, Linux, and Windows on arm64 and x64.

## Editor setup

\`\`\`sh
code --install-extension node_modules/vibelang/editor/vibelang.vsix
\`\`\`

Run the command from the project directory after installing dependencies, then
open the project. The extension runs the project's compiler as the language
server, \`vibelang --lsp --stdio\`, for diagnostics, hovers, and completions.`

const EFFECK_INSTALL_DOC = `# Installation

\`\`\`sh
bun create vibelang my-app
cd my-app
bun run start
\`\`\`

VibeLang compiles \`.vibe\` sources to JavaScript with the native \`vibelang\`
compiler. Version 0.0.1 installs from npm.

## Prerequisites

Install Node 26 or later and Bun 1.4 or later. The compiler is a native binary.
\`vibelang\` lists one package per platform as an optional dependency, and your
package manager installs only the one that matches your machine. Version 0.0.1
is tested on macOS on Apple silicon and on Linux on x64.

Keep optional dependencies enabled. If an install skips them, for example with
\`npm install --omit=optional\`, \`vibelang\` cannot find its binary and exits with an
error.

## Create a project

\`\`\`sh
bun create vibelang my-app
cd my-app
bun run start
bun run test
\`\`\`

With npm, run \`npm create vibelang@latest my-app\`. Either command copies the
starter into \`my-app\`, pins the VibeLang packages to the version that created it,
and installs dependencies. Pass \`--no-install\` to skip installation, then run
\`bun install\` in the project before building.

\`bun run start\` builds the project and prints:

\`\`\`
Hello, VibeLang!
Recovered from EmptyName
\`\`\`

See [Getting Started](effeck.dev/013-getting-started.html) for the starter's files.

## Add VibeLang to an existing project

\`\`\`sh
bun add vibelang-runtime@0.0.1 effect@4.0.5 @effect/platform-node@4.0.5
bun add -d vibelang@0.0.1 vibelang-vite@0.0.1 vitest@5.0.5 @effect/vitest@4.0.5
\`\`\`

With npm, run \`npm install --save-exact\` for the first line and
\`npm install --save-dev --save-exact\` for the second.`

const EFFECK_HOME_JSON = `{
  "blocks": [
    { "type": "text", "text": "VibeLang is Effect as a language: TypeScript syntax that compiles to TypeScript. (draft)" },
    { "type": "prompt", "title": "Ask about VibeLang", "placeholder": "Ask about VibeLang…" },
    { "type": "links", "links": [
      { "label": "Install VibeLang", "url": "https://effeck.dev/" },
      { "label": "Docs", "url": "https://effeck.dev/001-onboarding.html" },
      { "label": "Report a bug", "url": "https://smithers.sh/effeck/effeck/issues" },
      { "label": "Fixed by agents", "url": "https://smithers.sh/effeck/effeck/issues?view=factory" }
    ] },
    { "type": "markdown", "path": "docs/site/fixed-by-agents.md", "title": "Fixed by agents" }
  ]
}`

const EFFECK_USERS_MAIN = `export interface User {
  id: string
  name: string
}

export error UserNotFound { id: string }

export service Directory {
  lookup(id: string): User | undefined!!
}

export service Users {
  find(id: string): User!UserNotFound
}

export const DirectoryLive = Layer.succeed(Directory, {
  lookup(id) { return id === "42" ? { id, name: "Ada" } : undefined }
})

export const UsersLive = Layer.effect(Users) {
  const directory = Directory()
  return {
    find(id) {
      const user = directory.lookup(id)
      if (user === undefined) throw new UserNotFound({ id })
      return user
    }
  }
}

export const UsersTest = Layer.succeed(Users, {
  find(id) { return ({ id, name: "Grace" }) }
})

export const AppLive = wire(UsersLive, DirectoryLive)

export function greet(id: string) {
  try {
    const user = Users.find(id)
    return \`Welcome, \${user.name}!\`
  } catch (error) {
    return \`No user \${error.id}\`
  }
}

export function main() {
  provide AppLive {
    Console.log(greet("42"))
    Console.log(greet("missing"))
  }
}`

const EFFECK_USERS_README = `# Users

A service with a typed error, a layer, and a test double. \`Users.find\` fails
with \`UserNotFound\` when the directory has no entry; \`greet\` recovers it into
a sentence.

From this directory, with \`vibelang\` on \`PATH\`:

\`\`\`sh
bun install
bun run build
bun run start
bun run test
\`\`\`

Expected output: \`Welcome, Ada!\` then \`No user missing\`.`

const EFFECK_HATCHES_TS = `import { Cause, Effect, Exit } from "effect"

// The boundary hatches (D148): \`sync\`, \`try\`, and \`callback\` run plain
// TypeScript inside VibeLang. In a .vibe file a hatch's first argument is not
// VibeLang: calls do not run, \`throw\`, \`async\`, and \`await\` keep their
// JavaScript meaning, and platform APIs are allowed. That TypeScript is
// self-contained (D229): values reach it as inputs, the arguments after the
// function, which fill its first parameters (D230); an async function then
// receives the AbortSignal, and a callback \`resume\` and the signal.

/** The inputs a hatch passes to its function's first parameters (D230). */
type Inputs = ReadonlyArray<unknown>

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { readonly then?: unknown }).then === "function"

const call = (evaluate: unknown, inputs: Inputs): unknown => (evaluate as (...args: Array<unknown>) => unknown)(...inputs)

/**
 * D148: \`sync((n) => n * 2, count)\` is Effect.sync, so a throw is a defect; an
 * async function is Effect.promise, so a rejection is a defect; and
 * \`sync(expression)\` evaluates the expression when the Effect runs. Inputs
 * after the function fill its first parameters (D230).
 */
export function sync<R, Args extends Inputs = []>(evaluate: (...args: [...Args, AbortSignal]) => PromiseLike<R>, ...args: Args): Effect.Effect<R>
export function sync<R, Args extends Inputs = []>(evaluate: (...args: Args) => R, ...args: Args): Effect.Effect<Awaited<R>>
export function sync<A>(value: A): Effect.Effect<Awaited<A>>
export function sync(evaluate: unknown, ...inputs: Array<unknown>): Effect.Effect<unknown> {
  if (typeof evaluate !== "function") {
    return isPromiseLike(evaluate) ? Effect.promise(() => evaluate) : Effect.succeed(evaluate)
  }
  return Effect.suspend(() => {
    const result = call(evaluate, inputs)
    return isPromiseLike(result) ? Effect.promise(() => result) : Effect.succeed(result)
  })
}

/**
 * D148: \`try((text) => JSON.parse(text), text)\` is Effect.try, so a throw is an
 * expected Cause.UnknownError, or the error that \`mapError\` makes of it; an
 * async function is Effect.tryPromise; and \`try(expression)\` evaluates the
 * expression when the Effect runs. The mapper stays the second argument, and
 * inputs follow it (D231). Exported as \`try\`.
 */
export function attempt<R, E, Args extends Inputs = []>(
  evaluate: (...args: [...Args, AbortSignal]) => PromiseLike<R>,
  mapError: (error: unknown) => E,
  ...args: Args
): Effect.Effect<R, E>
export function attempt<R, Args extends Inputs = []>(evaluate: (...args: Args) => R, ...args: Args): Effect.Effect<Awaited<R>, Cause.UnknownError>
export function attempt<A>(value: A): Effect.Effect<Awaited<A>, Cause.UnknownError>
export function attempt(evaluate: unknown, ...rest: Array<unknown>): Effect.Effect<unknown, unknown> {
  // A function in second place is the mapper, as the overloads read it.
  const mapError = typeof rest[0] === "function" ? (rest[0] as (error: unknown) => unknown) : undefined
  const inputs = mapError ? rest.slice(1) : rest
  const run = typeof evaluate === "function" ? () => call(evaluate, inputs) : () => evaluate
  const failure = (error: unknown) => (mapError ? mapError(error) : new Cause.UnknownError(error))
  return Effect.suspend(() => {
    let result: unknown
    try {
      result = run()
    } catch (error) {
      return Effect.fail(failure(error))
    }
    if (!isPromiseLike(result)) return Effect.succeed(result)
    const pending = result
    return Effect.tryPromise({ try: () => pending, catch: failure })
  })
}

export { attempt as try }

/**
 * The \`resume\` a \`callback\` hatch receives. A .vibe file names it without an
 * import, to annotate \`resume\` where inputs keep callback's type arguments
 * from being written.
 */
export interface Resume<A, E> {
  /** Succeeds with value. */
  (value: A): void
  /** Fails with error, an expected failure. */
  readonly fail: (error: E) => void
  /** Ends as exit says. */
  readonly exit: (exit: Exit.Exit<A, E>) => void
}`

const SMITHERS_GITIGNORE = `node_modules
dist
.flows
*.log
.DS_Store`

const RPC_CARDS_TS = `/** Every card's wire schema, one discriminated union.
 * @since 1.0.0
 */

import { z } from "zod"
import { DiffCardSchema } from "./DiffCard.ts"

export const TextCardSchema = z.object({
  kind: z.literal("text"),
  markdown: z.string()
})

export const ErrorCardSchema = z.object({
  kind: z.literal("error"),
  message: z.string(),
  retry: z.boolean()
})

export const CardSchema = z.discriminatedUnion("kind", [
  TextCardSchema,
  ErrorCardSchema,
  DiffCardSchema
])
export type Card = z.infer<typeof CardSchema>`

const RPC_CHANGES_TS = `/** Change and review models shared by the app and the CLI.
 * @since 1.0.0
 */

import { z } from "zod"

export const CheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string()
})

export const ChangeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  branch: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  checks: z.array(CheckSchema)
})
export type Change = z.infer<typeof ChangeSchema>`

const RPC_DIFFCARD_TS = `/** The unified diff card: hunks with old and new line numbers.
 * @since 1.0.0
 */

import { z } from "zod"

export const DiffLineSchema = z.object({
  kind: z.enum(["context", "add", "remove", "hunk"]),
  text: z.string(),
  oldLine: z.number().int().optional(),
  newLine: z.number().int().optional()
})

export const DiffCardSchema = z.object({
  kind: z.literal("diff"),
  path: z.string(),
  lines: z.array(DiffLineSchema)
})`

const EFFECK_USERS_TEST = `import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { greet, Users, UsersTest } from "./main.vibe"

it.effect("greets a known user", () =>
  Effect.gen(function* () {
    expect(yield* greet("42")).toBe("Welcome, Grace!")
  }).pipe(Effect.provide(UsersTest))
)`

const EFFECK_USERS_PACKAGE_JSON = `{
  "name": "vibelang-example-users",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vibelang -p .",
    "start": "node dist/main.js",
    "test": "vibelang --vitest -p . && vitest run"
  },
  "dependencies": {
    "effect": "4.0.5",
    "vibelang-runtime": "0.0.1"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.5",
    "vibelang": "0.0.1",
    "vitest": "5.0.5"
  }
}`

const EFFECK_USERS_VITEST = `import { defineConfig } from "vitest/config"
import vibelang from "vibelang-vite"

export default defineConfig({
  plugins: [vibelang()]
})`

const EFFECK_USERS_EXPECTED = `Welcome, Ada!
No user missing
`

const EXAMPLE_MAIN_EFFECK = `export function main() {
  Console.log("Hello, VibeLang!")
}`

const EXAMPLE_README = `# Hello

The smallest Node.js VibeLang program: one function and one log. \`Console.log\`
runs when called. The module exports \`main\`, so running its JavaScript with
\`node dist/main.js\` runs \`main\` with \`NodeRuntime.runMain\`.

## Try it

\`\`\`sh
npm create vibelang@latest my-app
cd my-app
npm install
npm start
\`\`\`

Expected output: \`Hello, VibeLang!\`.

The key function in Effect TypeScript is:

\`\`\`ts
import { Console, Effect } from "effect"
const main = Effect.fnUntraced(function* () {
  yield* Console.log("Hello, VibeLang!")
})
\`\`\`

The compiler ends \`main.js\` with \`if (import.meta.main) NodeRuntime.runMain(main())\`,
so importing the module runs nothing.`

const EXAMPLE_PACKAGE_JSON = `{
  "name": "vibelang-example-hello",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vibelang -p .",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "effect": "4.0.5",
    "@effect/platform-node": "4.0.5",
    "vibelang-runtime": "0.0.1"
  },
  "devDependencies": {
    "vibelang": "0.0.1"
  }
}`

const EXAMPLE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src"]
}`

const EXAMPLE_EXPECTED = `Hello, VibeLang!
`

const GREET_TS = `export const greet = (name: string): string => {
  const trimmed = name.trim()
  return trimmed === "" ? "Hello, world!" : \`Hello, \${trimmed}!\`
}`

const GREET_TEST_TS = `import { expect, test } from "bun:test"
import { greet } from "../src/greet.ts"

test("greets a name", () => {
  expect(greet("Ada")).toBe("Hello, Ada!")
})

test("falls back to world", () => {
  expect(greet("  ")).toBe("Hello, world!")
})`

const HELLO_PACKAGE_JSON = `{
  "name": "hello-smithers",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}`

const HELLO_README = `# hello-smithers

A TypeScript greeting function and its tests: the Smithers example repo.

## What's here

- \`src/greet.ts\` — \`greet(name)\` returns a greeting, or "Hello, world!" for a blank name
- \`test/greet.test.ts\` — bun:test coverage for both cases

## Try it

\`\`\`sh
bun install
bun test
\`\`\`

Ask Smithers for a change, for example "Add Spanish greetings and test both".
The change arrives as a pull request on your copy; you review and merge it.`

const TINYHTTP_README = `# tinyhttp

A 400-line HTTP router for Bun and Node. Routes take params (\`/users/:id\`),
the query string parses into a plain object, and a handler returns a
\`Response\`.

## Use it

\`\`\`ts
import { Router } from "./src/router.ts"

const app = new Router()
app.get("/users/:id", (req) => Response.json({ id: req.params.id }))

const res = await app.handle("GET", "/users/42?verbose=1")
\`\`\`

## Test

\`\`\`sh
bun test
\`\`\`

31 tests cover routing, params, and query parsing.`

const ROUTER_TS = `import { parseQuery } from "./query.ts"

export interface Request {
  method: string
  path: string
  params: Record<string, string>
  query: Record<string, string>
}

export type Handler = (req: Request) => Response | Promise<Response>

interface Route {
  method: string
  segments: string[]
  handler: Handler
}

const split = (path: string): string[] => path.split("/").filter(part => part !== "")

export class Router {
  private routes: Route[] = []

  get(path: string, handler: Handler): void {
    this.add("GET", path, handler)
  }

  post(path: string, handler: Handler): void {
    this.add("POST", path, handler)
  }

  put(path: string, handler: Handler): void {
    this.add("PUT", path, handler)
  }

  delete(path: string, handler: Handler): void {
    this.add("DELETE", path, handler)
  }

  private add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, segments: split(path), handler })
  }

  async handle(method: string, url: string): Promise<Response> {
    const [rawPath, rawQuery = ""] = url.split("?")
    const path = split(rawPath)
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== path.length) continue
      const params: Record<string, string> = {}
      let match = true
      for (let i = 0; i < path.length; i += 1) {
        const segment = route.segments[i]
        if (segment.startsWith(":")) params[segment.slice(1)] = path[i]
        else if (segment !== path[i]) { match = false; break }
      }
      if (!match) continue
      const query = parseQuery(rawQuery)
      return route.handler({ method, path: rawPath, params, query })
    }
    return new Response("Not found", { status: 404 })
  }
}`

const QUERY_TS = `const decode = (value: string): string => decodeURIComponent(value.replace(/\\+/g, " "))

export function parseQuery(input: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const pair of input.split("&")) {
    if (pair === "") continue
    const eq = pair.indexOf("=")
    if (eq === -1) continue
    params[decode(pair.slice(0, eq))] = decode(pair.slice(eq + 1))
  }
  return params
}

export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => \`\${encodeURIComponent(key)}=\${encodeURIComponent(value)}\`)
    .join("&")
}`

const QUERY_TEST_TS = `import { expect, test } from "bun:test"
import { buildQuery, parseQuery } from "../src/query.ts"

test("parses pairs", () => {
  expect(parseQuery("a=1&b=2")).toEqual({ a: "1", b: "2" })
})

test("parses encoded values", () => {
  expect(parseQuery("a=%2Fb")).toEqual({ a: "/b" })
})

test("decodes plus as space", () => {
  expect(parseQuery("q=hello+world")).toEqual({ q: "hello world" })
})

test("round-trips through buildQuery", () => {
  expect(parseQuery(buildQuery({ a: "1", b: "/x" }))).toEqual({ a: "1", b: "/x" })
})`

const TINYHTTP_PACKAGE_JSON = `{
  "name": "tinyhttp",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}`

const NOTES_API_README = `# notes-api

Markdown notes over a small REST API. Notes live as \`.md\` files; the API
lists, reads, creates, and searches them.

## Run

\`\`\`sh
bun run src/server.ts
\`\`\`

\`GET /notes\` lists, \`GET /notes/:slug\` reads, \`POST /notes\` creates.`

const NOTES_SERVER_TS = `import { Router } from "./router.ts"

const app = new Router()

app.get("/notes", async () => {
  const files = await Array.fromAsync(new Bun.Glob("*.md").scan("notes"))
  return Response.json({ notes: files.map(file => file.replace(/\\.md$/, "")) })
})

app.get("/notes/:slug", async (req) => {
  const file = Bun.file(\`notes/\${req.params.slug}.md\`)
  if (!(await file.exists())) return new Response("Not found", { status: 404 })
  return Response.json({ slug: req.params.slug, body: await file.text() })
})

export default app`

export const REPOS: Record<string, RepoData> = {
  "smithers-canary/smithers": {
    slug: "smithers-canary/smithers",
    site: "smithers",
    description: "Mirror of github.com/smithersai/smithers. Durable agent coding on your own subscription.",
    license: "MIT",
    github: "https://github.com/smithersai/smithers",
    mirrorOf: "https://github.com/smithersai/smithers",
    lastChange: "2 hours ago",
    text: "Smithers runs coding agents on your repo. People review and merge what they make.",
    askTitle: "Ask about Smithers",
    askPlaceholder: "Ask about Smithers…",
    visitorChips: ["How does a stopped run resume?", "Where does a change get verified?", "How do I install it?"],
    memberChips: ["Fix an issue", "Review a change", "Ask the codebase"],
    links: [
      { label: "Docs", route: "smithers.sh/docs" },
      { label: "Report a bug", card: "bug" },
      { label: "Fixed by agents", route: "smithers.sh/smithers-canary/smithers/issues?view=factory" }
    ],
    fixed: [
      { date: "Oct 17", issue: 4235, title: "First coding request waits 4 minutes before failing", sha: "3f2a91c", agent: "Claude Code" },
      { date: "Oct 17", issue: 4236, title: "The app polled a TODO route that doesn't exist", sha: "9d41bb0", agent: "Claude Code" },
      { date: "Oct 16", issue: 4231, title: "rc.12 couldn't plan the flow init generates", sha: "5aa128c", agent: "Codex" },
      { date: "Oct 15", issue: 4218, title: "pnpm's verify flag reached tools it ran", sha: "7ac3d22", agent: "Codex" }
    ],
    tree: {
      "": [
        { name: ".smithers", kind: "dir", note: "The repo's own flows and home", age: "3 hours ago" },
        { name: "apps", kind: "dir", note: "The app, the site and the TUI", age: "yesterday" },
        { name: "docs", kind: "dir", note: "Guides and reference", age: "2 days ago" },
        { name: "packages", kind: "dir", note: "Engine, CLI and libraries", age: "4 hours ago" },
        { name: ".gitignore", kind: "file", note: "", age: "12 days ago" },
        { name: "LICENSE", kind: "file", note: "MIT", age: "3 months ago" },
        { name: "package.json", kind: "file", note: "Workspace root", age: "yesterday" },
        { name: "README.md", kind: "file", note: "What Smithers is", age: "3 hours ago" }
      ],
      "packages/rpc/src": [
        { name: "Cards.ts", kind: "file", note: "Every card's wire schema", age: "2 days ago" },
        { name: "Changes.ts", kind: "file", note: "Change and review models", age: "yesterday" },
        { name: "DiffCard.ts", kind: "file", note: "Unified diff card", age: "4 days ago" },
        { name: "RepositoryHome.ts", kind: "file", note: "home.json blocks, validated", age: "3 hours ago" }
      ]
    },
    dirReadmes: {},
    files: {
      "README.md": { content: SMITHERS_README, lang: "md" },
      "package.json": { content: SMITHERS_PACKAGE_JSON, lang: "json" },
      "LICENSE": { content: LICENSE, lang: "txt" },
      ".gitignore": { content: SMITHERS_GITIGNORE, lang: "txt" },
      "packages/rpc/src/RepositoryHome.ts": { content: REPOSITORY_HOME_TS, lang: "ts" },
      "packages/rpc/src/Cards.ts": { content: RPC_CARDS_TS, lang: "ts" },
      "packages/rpc/src/Changes.ts": { content: RPC_CHANGES_TS, lang: "ts" },
      "packages/rpc/src/DiffCard.ts": { content: RPC_DIFFCARD_TS, lang: "ts" },
      "packages/smithers/flows/src/Runtime.ts": { content: RUNTIME_TS, lang: "ts" },
      "packages/smithers/flows/src/NodeRuntime.ts": { content: NODE_RUNTIME_TS, lang: "ts" }
    },
    readme: SMITHERS_README,
    issues: [
      { n: 4252, title: "First run on a fresh import shows a blank card for 30 seconds", state: "open", labels: ["bug", "from-app"], author: "maya", opened: "1 hour ago", body: "I imported maya/tinyhttp and asked for a change. The run card appeared empty for about 30 seconds before the first stage showed.\n\nI expected the run's first stage to show right away.\n\nSteps: import a repo, ask for a change, watch the new run card.", comments: [], receipt: { stage: "reported", reporter: "maya", reported: "Oct 17" } },
      { n: 3830, title: "smithersai/smithers can't be served on smithers.sh", state: "open", labels: ["bug"], author: "will", opened: "4 days ago", body: "An older private repo holds the smithersai/smithers name, and the product can't rename repos. Until the rename lands, Smithers-on-Smithers is the mirror at smithers-canary/smithers.", comments: [{ who: "will", text: "Rename is scheduled after launch; the mirror stays reachable until then.", when: "3 days ago" }] },
      { n: 4232, title: "No documented code-request to review to land path", state: "open", labels: ["docs", "accepted"], author: "cora", opened: "2 days ago", body: "The quickstart ends at a running flow. A new user can't find the path from asking for a code change to reviewing and landing it.\n\nThe docs need one recipe: ask, watch the run, read the change, merge.", comments: [{ who: "will", text: "Accepted. This is the launch blocker; the tutorial lane is on it.", when: "2 days ago" }, { who: "bot", text: "Drafted the recipe against rc.12; verifying each command on a clean HOME.", when: "1 day ago" }], receipt: { stage: "working", reporter: "cora", reported: "Oct 15", acceptedBy: "will", accepted: "Oct 15", run: "run-4730", agent: "Codex" } },
      { n: 4233, title: "Quickstart next steps use a flow the user never got", state: "open", labels: ["docs"], author: "cora", opened: "2 days ago", body: "After `smthrs init change`, the printed next steps reference a `review` flow that init doesn't scaffold.", comments: [] },
      { n: 4234, title: "parked-plan exit code is documented as 3 but is 0", state: "open", labels: ["bug", "docs"], author: "cora", opened: "2 days ago", body: "`smthrs flow plan` on a parked plan exits 0; the CLI reference says 3.", comments: [] },
      { n: 4237, title: "Installation page lists Homebrew as planned", state: "open", labels: ["docs"], author: "cora", opened: "1 day ago", body: "The install page's Homebrew section says \"Planned\" with no working command. The npm path works.", comments: [] },
      { n: 4240, title: "Sign-out leaves the repo menu showing the old account", state: "open", labels: ["bug"], author: "maya", opened: "1 day ago", body: "After signing out, the repo menu still lists my imported repos until a reload.", comments: [] },
      { n: 4249, title: "Guest chat answers from a week-old README", state: "open", labels: ["bug"], author: "will", opened: "20 hours ago", body: "The guest answer for \"How do I install it?\" quoted the install command from before rc.13. The context bundle should rebuild on each release.", comments: [] },
      { n: 4235, title: "First coding request waits 4 minutes before failing", state: "closed", labels: ["bug", "accepted"], author: "will", opened: "2 days ago", body: "A first coding request on a fresh import waited 3 m 45 s, then failed with \"Every model host is busy\". The refusal should come back within 10 seconds with the reason.", comments: [{ who: "bot", text: "Reproduced: the admission call blocked on the sandbox pool. Opened #44, which refuses with host_no_capacity in under a second and counts the refusal.", when: "1 day ago" }, { who: "will", text: "Verified on the walk: refusal arrives in 2 s with the maintenance note. Merged as 3f2a91c.", when: "18 hours ago" }], receipt: { stage: "merged", reporter: "will", reported: "Oct 16", acceptedBy: "will", accepted: "Oct 16", run: "run-4719", pull: 44, commit: "3f2a91c", agent: "Claude Code" } },
      { n: 4236, title: "The app polled a TODO route that doesn't exist", state: "closed", labels: ["bug", "accepted"], author: "will", opened: "2 days ago", body: "Signed in, the app issued 226 console errors in one session, mostly 404s on a TODO route the hosted build doesn't mount.", comments: [{ who: "bot", text: "The poller now checks composition before subscribing. Opened #41.", when: "2 days ago" }], receipt: { stage: "merged", reporter: "will", reported: "Oct 16", acceptedBy: "will", accepted: "Oct 16", run: "run-4712", pull: 41, commit: "9d41bb0", agent: "Claude Code" } },
      { n: 4231, title: "rc.12 cannot plan the flow init generates", state: "closed", labels: ["bug", "accepted"], author: "cora", opened: "3 days ago", body: "On a clean HOME, `smthrs init change` then `smthrs flow plan change` fails to plan the scaffolded flow. Fixed on main by 5aa128c; needs an rc to reach users.", comments: [{ who: "bot", text: "The scaffold declared an input the planner required twice. Opened #38 with the fix and a regression test on a clean HOME.", when: "3 days ago" }], receipt: { stage: "merged", reporter: "cora", reported: "Oct 15", acceptedBy: "will", accepted: "Oct 15", run: "run-4690", pull: 38, commit: "5aa128c", agent: "Codex" } },
      { n: 4218, title: "pnpm's verify flag reached tools it ran", state: "closed", labels: ["bug", "accepted"], author: "will", opened: "4 days ago", body: "The build CLI passed pnpm's `--verify` flag to a tool invoked with `pnpm run`, and the tool rejected it.", comments: [], receipt: { stage: "merged", reporter: "will", reported: "Oct 14", acceptedBy: "will", accepted: "Oct 14", run: "run-4651", pull: 35, commit: "7ac3d22", agent: "Codex" } },
      { n: 4217, title: "An overlay's .smithers didn't mount onto a pinned upstream checkout", state: "closed", labels: ["bug"], author: "cora", opened: "4 days ago", body: "Building with an overlay lost the repo's own flows: the overlay's `.smithers` never mounted onto the pinned upstream tree.", comments: [], receipt: { stage: "merged", reporter: "cora", reported: "Oct 14", acceptedBy: "will", accepted: "Oct 14", run: "run-4648", pull: 34, commit: "5f8e1c4", agent: "Claude Code" } },
      { n: 4200, title: "Native host executable cache replacement untested", state: "closed", labels: ["accepted"], author: "will", opened: "5 days ago", body: "Replacing a native host executable in the action cache had no coverage; a stale binary could survive a toolchain update.", comments: [], receipt: { stage: "merged", reporter: "will", reported: "Oct 13", acceptedBy: "will", accepted: "Oct 13", run: "run-4602", pull: 30, commit: "2b6c91d", agent: "Codex" } },
      { n: 4145, title: "Authenticated provider workspace paths not normalized", state: "closed", labels: ["bug"], author: "cora", opened: "9 days ago", body: "A coding run over an authenticated provider saw the workspace at two different paths and wrote to the wrong one.", comments: [], receipt: { stage: "merged", reporter: "cora", reported: "Oct 9", acceptedBy: "will", accepted: "Oct 9", run: "run-4488", pull: 22, commit: "81e3a07", agent: "Claude Code" } }
    ],
    pulls: [
      { n: 44, title: "Refuse a hosted run within 10 seconds when no machine is free", state: "open", branch: "smithers/fix-4235", forWho: "will", opened: "1 day ago", fixes: 4235, commit: { sha: "3f2a91c", subject: "fix(hosted): refuse a run within 10 s when no machine is free" }, checks: [
        { name: "Typecheck", ok: true, detail: "41 s" },
        { name: "Unit tests", ok: true, detail: "2 m 10 s · 1,204 passed" },
        { name: "Site e2e", ok: true, detail: "1 m 02 s" },
        { name: "Lint", ok: true, detail: "18 s" }
      ], additions: 38, deletions: 6, summary: "The admission call blocked on the sandbox pool for the full claim timeout before surfacing host_no_capacity. The pool now answers capacity first, so a refusal returns in under a second with the reason, and the refusal is counted before the return so retries don't double-count.", findings: [
        { file: "packages/backend/internal/services/hosted_admit.go", line: 91, text: "Refusal is counted before the return, so a retried request can't double-count." },
        { file: "packages/backend/internal/services/hosted_admit_test.go", line: 41, text: "Covers the refusal path and the metric." }
      ], diff: [
        { path: "packages/backend/internal/services/hosted_admit.go", lines: [
          { kind: "hunk", text: "@@ -88,6 +88,16 @@ func (s *HostedAdmit) Admit(ctx context.Context, req AdmitRequest) (Admission, error) {" },
          { kind: "ctx", old: 88, new: 88, text: "\tmachine, err := s.pool.Claim(ctx, req.Repo)" },
          { kind: "ctx", old: 89, new: 89, text: "\tif err != nil {" },
          { kind: "add", new: 90, text: "\t\tif errors.Is(err, pool.ErrNoCapacity) {" },
          { kind: "add", new: 91, text: "\t\t\ts.metrics.RunRefused(ctx, \"host_no_capacity\")" },
          { kind: "add", new: 92, text: "\t\t\treturn Admission{}, &RefusedError{" },
          { kind: "add", new: 93, text: "\t\t\t\tReason: \"host_no_capacity\"," },
          { kind: "add", new: 94, text: "\t\t\t\tDetail: \"No machine is free. Nothing ran and nothing was charged.\"," },
          { kind: "add", new: 95, text: "\t\t\t}" },
          { kind: "add", new: 96, text: "\t\t}" },
          { kind: "ctx", old: 90, new: 97, text: "\t\treturn Admission{}, fmt.Errorf(\"claim machine: %w\", err)" },
          { kind: "ctx", old: 91, new: 98, text: "\t}" }
        ] },
        { path: "packages/backend/internal/services/hosted_admit_test.go", lines: [
          { kind: "hunk", text: "@@ -36,4 +36,12 @@ func TestAdmit(t *testing.T) {" },
          { kind: "ctx", old: 36, new: 36, text: "})" },
          { kind: "add", new: 37, text: "" },
          { kind: "add", new: 38, text: "func TestAdmitRefusesWithoutCapacity(t *testing.T) {" },
          { kind: "add", new: 39, text: "\tpool := &stubPool{err: pool.ErrNoCapacity}" },
          { kind: "add", new: 40, text: "\t_, err := NewHostedAdmit(pool).Admit(context.Background(), req)" },
          { kind: "add", new: 41, text: "\tvar refused *RefusedError" },
          { kind: "add", new: 42, text: "\trequire.ErrorAs(t, err, &refused)" },
          { kind: "add", new: 43, text: "\trequire.Equal(t, \"host_no_capacity\", refused.Reason)" },
          { kind: "add", new: 44, text: "}" }
        ] }
      ] },
      { n: 41, title: "Stop polling an absent TODO route", state: "merged", branch: "smithers/fix-4236", forWho: "will", opened: "2 days ago", fixes: 4236, commit: { sha: "9d41bb0", subject: "fix(app): stop polling an absent TODO route" }, checks: [
        { name: "Typecheck", ok: true, detail: "39 s" },
        { name: "Unit tests", ok: true, detail: "2 m 04 s · 1,198 passed" },
        { name: "Site e2e", ok: true, detail: "58 s" },
        { name: "Lint", ok: true, detail: "17 s" }
      ], additions: 24, deletions: 11, summary: "The app subscribed to the TODO route before checking whether the composition mounts it. The poller now checks composition first.", findings: [], diff: [], mergedSha: "9d41bb0" },
      { n: 38, title: "Plan the flow init generates", state: "merged", branch: "smithers/fix-4231", forWho: "will", opened: "3 days ago", fixes: 4231, commit: { sha: "5aa128c", subject: "fix(cli): plan the scaffolded change flow" }, checks: [
        { name: "Typecheck", ok: true, detail: "40 s" },
        { name: "Unit tests", ok: true, detail: "2 m 01 s · 1,190 passed" },
        { name: "Site e2e", ok: true, detail: "55 s" },
        { name: "Lint", ok: true, detail: "16 s" }
      ], additions: 19, deletions: 4, summary: "The scaffold declared one input twice; the planner refused it. The declaration is deduplicated and a clean-HOME regression test covers it.", findings: [], diff: [], mergedSha: "5aa128c" }
    ],
    runs: [
      { id: "run-4719", title: "Fix #4235: refuse a hosted run within 10 s when no machine is free", agent: "Claude Code", started: "Oct 17, 4:12 pm", status: "done", activeStage: 6, stages: [
        { label: "Admitted", summary: "1 of 3 machines", log: ["queue: admitted at position 1", "reservation: will (Claude Code)"], duration: "2 s" },
        { label: "Allocating a machine", summary: "Allocated mm-2 · 4 vCPU", log: ["machine mm-2 claimed", "image smithers-worker:2026.10.15"], duration: "9 s" },
        { label: "Cloning", summary: "Cloned smithers-canary/smithers at 4be19d0", log: ["fetch depth 1", "checkout main"], duration: "6 s" },
        { label: "Model working", summary: "Claude Code edited hosted_admit.go · 2 files", log: ["read packages/backend/internal/services/hosted_admit.go", "wrote packages/backend/internal/services/hosted_admit_test.go"], duration: "3 m 12 s" },
        { label: "Verifying", summary: "go test ./... · 1,204 passed", log: ["typecheck ok", "unit: 1,204 passed, 0 failed", "lint ok"], duration: "2 m 51 s" },
        { label: "Pull request opened", summary: "Opened #44", log: ["branch smithers/fix-4235", "commit 3f2a91c"], duration: "4 s" }
      ] },
      { id: "run-4730", title: "Document the code-request to review to land path", agent: "Codex", started: "Oct 17, 6:40 pm", status: "running", activeStage: 3, stages: [
        { label: "Admitted", summary: "2 of 3 machines", log: ["queue: admitted at position 1"], duration: "1 s" },
        { label: "Allocating a machine", summary: "Allocated mm-1 · 4 vCPU", log: ["machine mm-1 claimed"], duration: "8 s" },
        { label: "Cloning", summary: "Cloned smithers-canary/smithers at 9d41bb0", log: ["fetch depth 1"], duration: "6 s" },
        { label: "Model working", summary: "Codex is drafting the recipe", log: ["read apps/site/src/content/docs/cli-quickstart.md", "writing the recipe against rc.12"], duration: "" },
        { label: "Verifying", summary: "", log: [], duration: "" },
        { label: "Pull request opened", summary: "", log: [], duration: "" }
      ] }
    ],
    answers: [
      { q: "How does a stopped run resume?", disclosure: "Worked for 6 s · Read 4 files", files: [
        { path: "packages/smithers/flows/src/Runtime.ts", label: "Runtime.ts:11-14" },
        { path: "packages/smithers/flows/src/Runtime.ts", label: "Runtime.ts:60-86" },
        { path: "packages/smithers/flows/src/NodeRuntime.ts", label: "NodeRuntime.ts:15-20" },
        { path: "README.md", label: "README.md" }
      ], md: "A killed run resumes with `smthrs runs resume`, continuing where it stopped. See the [runtime](smithers.sh/smithers-canary/smithers/blob/main/packages/smithers/flows/src/Runtime.ts?L=11-14) and [run storage](smithers.sh/smithers-canary/smithers/blob/main/packages/smithers/flows/src/Runtime.ts?L=60-86).", openOwn: true },
      { q: "Where does a change get verified?", disclosure: "Worked for 5 s · Read 3 files", files: [
        { path: "package.json", label: "package.json:24-25" },
        { path: "packages/rpc/src/RepositoryHome.ts", label: "RepositoryHome.ts:51-60" },
        { path: "README.md", label: "README.md" }
      ], md: "On the repo's own checks. The agent's branch runs typecheck, the unit suite, the site e2e and lint before a pull request opens — the same scripts in [package.json:24-25](smithers.sh/smithers-canary/smithers/blob/main/package.json?L=24-25).\n\nA person then reviews the diff and the checks on the change card, and merges on GitHub. Agents never merge.", openOwn: true },
      { q: "How do I install it?", disclosure: "Worked for 4 s · Read 2 files", files: [
        { path: "README.md", label: "README.md:17-21" },
        { path: "package.json", label: "package.json" }
      ], md: "Install the CLI from npm, then scaffold a flow in your project:\n\n```bash\nnpm install -g smthrs@next\nsmthrs init change\nsmthrs flow start change\n```\n\nThe [README](smithers.sh/smithers-canary/smithers/blob/main/README.md?L=17-21) covers it, and [Installation](smithers.sh/docs/installation) walks a clean machine through it. The release candidate needs Linux with Node 26.4.0.", openOwn: true }
    ],
    memberButtons: false
  },

  "effeck/effeck": {
    slug: "effeck/effeck",
    site: "effeck",
    description: "Effect, as a language.",
    license: "MIT",
    github: null,
    lastChange: "5 hours ago",
    text: "VibeLang is Effect as a language: TypeScript syntax that compiles to TypeScript.",
    askTitle: "Ask about VibeLang",
    askPlaceholder: "Ask about VibeLang…",
    visitorChips: ["How do typed errors work?", "How do I call an npm package?", "What does the converter handle?"],
    memberChips: ["Fix an issue", "Review a change", "Ask the codebase"],
    links: [
      { label: "Convert Effect code", route: "effeck.dev/", needsConverter: true },
      { label: "Docs", route: "effeck.dev/001-onboarding.html" },
      { label: "Report a bug", route: "smithers.sh/effeck/effeck/issues" },
      { label: "Fixed by agents", route: "smithers.sh/effeck/effeck/issues?view=factory" }
    ],
    fixed: [
      { date: "Oct 16", issue: 98, title: "Hover on a VibeLang form panicked the language server", sha: "7e2c4a1", agent: "Claude Code" },
      { date: "Oct 15", issue: 101, title: "npm publish failed on the Windows packages", sha: "4be19d0", agent: "Codex" },
      { date: "Oct 14", issue: 95, title: "Docs pages had no Markdown copies", sha: "61f3c8e", agent: "Claude Code" },
      { date: "Oct 13", issue: 89, title: "A wide contract bound callers that run nothing", sha: "9a02b7f", agent: "Codex" }
    ],
    tree: {
      "": [
        { name: ".smithers", kind: "dir", note: "home.json and the guest instructions", age: "5 hours ago" },
        { name: "docs", kind: "dir", note: "Guides, the spec and the decision log", age: "yesterday" },
        { name: "examples", kind: "dir", note: "hello, users, and the framework examples", age: "2 days ago" },
        { name: "packages", kind: "dir", note: "Compiler, runtime and editor", age: "5 hours ago" },
        { name: "typescript", kind: "dir", note: "TypeScript 7 (Go) with the VibeLang commits", age: "3 days ago" },
        { name: "LICENSE", kind: "file", note: "MIT", age: "2 months ago" },
        { name: "README.md", kind: "file", note: "What VibeLang is", age: "5 hours ago" }
      ],
      "examples/users": [
        { name: "src", kind: "dir", note: "main.vibe and its test", age: "4 days ago" },
        { name: "expected-output.txt", kind: "file", note: "Welcome, Ada!", age: "4 days ago" },
        { name: "package.json", kind: "file", note: "", age: "4 days ago" },
        { name: "README.md", kind: "file", note: "", age: "4 days ago" },
        { name: "tsconfig.json", kind: "file", note: "", age: "4 days ago" },
        { name: "vitest.config.ts", kind: "file", note: "", age: "4 days ago" }
      ],
      "examples/users/src": [
        { name: "main.vibe", kind: "file", note: "a service with a typed error", age: "4 days ago" },
        { name: "main.test.vibe", kind: "file", note: "the test double", age: "4 days ago" }
      ]
    },
    dirReadmes: { "examples/users": EFFECK_USERS_README },
    files: {
      "README.md": { content: EFFECK_README, lang: "md" },
      "LICENSE": { content: LICENSE, lang: "txt" },
      "examples/users/src/main.vibe": { content: EFFECK_USERS_MAIN, lang: "ts" },
      "examples/users/src/main.test.vibe": { content: EFFECK_USERS_TEST, lang: "ts" },
      "examples/users/README.md": { content: EFFECK_USERS_README, lang: "md" },
      "examples/users/package.json": { content: EFFECK_USERS_PACKAGE_JSON, lang: "json" },
      "examples/users/expected-output.txt": { content: EFFECK_USERS_EXPECTED, lang: "txt" },
      "examples/users/tsconfig.json": { content: EXAMPLE_TSCONFIG, lang: "json" },
      "examples/users/vitest.config.ts": { content: EFFECK_USERS_VITEST, lang: "ts" },
      "packages/runtime/src/hatches.ts": { content: EFFECK_HATCHES_TS, lang: "ts" },
      "docs/user/src/getting-started/004-installation.md": { content: EFFECK_INSTALL_DOC, lang: "md" },
      ".smithers/home.json": { content: EFFECK_HOME_JSON, lang: "json" }
    },
    readme: EFFECK_README,
    issues: [
      { n: 118, title: "Conversion did not compile: Schema.Class field with a default", state: "open", labels: ["converter", "from-app"], author: "maya", opened: "40 minutes ago", body: "The converter dropped the `.pipe(Schema.optional)` modifier on a `Schema.Class` field, and the result failed `vibelang --noEmit` with EK4301.\n\nInput: 20 lines of Effect. Output: 15 lines of VibeLang. 2 diagnostics. vibelang 0.0.1, compiler sha256:4be1…", comments: [], receipt: { stage: "reported", reporter: "maya", reported: "Oct 17" } },
      { n: 114, title: "Converter rejects a stream pipeline the compiler accepts", state: "open", labels: ["converter"], author: "cora", opened: "1 day ago", body: "A `Stream.filter(p).take(3)` chain converts to a `forEach` that drops the `take`. The original compiles; the conversion doesn't terminate the stream.", comments: [] },
      { n: 109, title: "EK4301 code frame points at an unrelated Vitest file", state: "open", labels: ["bug"], author: "maya", opened: "2 days ago", body: "A whole-program compiler error shows a code frame from an unrelated Vitest file instead of the `.vibe` source. Suspected in vibelang-vite's transform, around its sourcemap plumbing.", comments: [{ who: "cora", text: "Reproduced on the users example with a contract-less callback.", when: "1 day ago" }] },
      { n: 112, title: "Setup pages don't name the Neovim LSP setup", state: "open", labels: ["docs"], author: "cora", opened: "2 days ago", body: "The setup page covers the VS Code extension and points at editors/ for the rest. Neovim users need the two-line `vim.lsp` snippet on the page itself.", comments: [] },
      { n: 116, title: "Hover notes duplicate the JSDoc on service methods", state: "open", labels: ["bug"], author: "maya", opened: "1 day ago", body: "Hovering a `service` method shows the VibeLang hover note, then the rule, then the JSDoc — but the JSDoc appears twice when the method has an overload.", comments: [] },
      { n: 117, title: "unplugin: Rspack build warns on the vibelang virtual module", state: "open", labels: ["converter"], author: "cora", opened: "20 hours ago", body: "`vibelang-unplugin` under Rspack prints \"virtual module vibelang/hatches resolved twice\" on every rebuild. The build still passes.", comments: [] },
      { n: 98, title: "Hover on a VibeLang form panicked the language server", state: "closed", labels: ["bug", "accepted"], author: "maya", opened: "4 days ago", body: "`vibelang --lsp --stdio` panicked when hovering a `service` declaration's name. The hover now resolves VibeLang forms first, then the rule, then the JSDoc.", comments: [{ who: "bot", text: "Reproduced with the users example. The hover walker assumed a JSDoc node; VibeLang forms don't carry one. Fixed and covered by the LSP hover suite.", when: "3 days ago" }], receipt: { stage: "merged", reporter: "maya", reported: "Oct 13", acceptedBy: "will", accepted: "Oct 13", run: "run-310", commit: "7e2c4a1", agent: "Claude Code" } },
      { n: 101, title: "npm publish failed on the Windows packages", state: "closed", labels: ["accepted"], author: "will", opened: "3 days ago", body: "Publishing 0.0.1 failed partway: the Windows per-platform packages weren't ready, and npm refuses a partial set. The release now publishes without the Windows packages and says so on Windows.", comments: [], receipt: { stage: "merged", reporter: "will", reported: "Oct 14", acceptedBy: "will", accepted: "Oct 14", run: "run-318", commit: "4be19d0", agent: "Codex" } },
      { n: 95, title: "Docs pages had no Markdown copies", state: "closed", labels: ["docs", "accepted"], author: "cora", opened: "5 days ago", body: "Each docs page needed a `.md` twin and an `llms.txt`, so agents and readers can take the plain text.", comments: [], receipt: { stage: "merged", reporter: "cora", reported: "Oct 12", acceptedBy: "will", accepted: "Oct 12", run: "run-296", commit: "61f3c8e", agent: "Claude Code" } },
      { n: 89, title: "A wide contract bound callers that run nothing", state: "closed", labels: ["bug", "accepted"], author: "maya", opened: "6 days ago", body: "A function whose declared contract was wider than its body still bound its callers to the wider dependencies.", comments: [], receipt: { stage: "merged", reporter: "maya", reported: "Oct 11", acceptedBy: "will", accepted: "Oct 11", run: "run-281", commit: "9a02b7f", agent: "Codex" } },
      { n: 92, title: "Examples didn't link the Bun cache defect", state: "closed", labels: ["docs"], author: "cora", opened: "5 days ago", body: "The examples hit Bun's cache defect under `--no-cache` without naming the upstream issue.", comments: [], receipt: { stage: "merged", reporter: "cora", reported: "Oct 12", acceptedBy: "will", accepted: "Oct 12", run: "run-290", commit: "c58d1e2", agent: "Claude Code" } }
    ],
    pulls: [],
    runs: [
      { id: "run-310", title: "Fix #98: hover on a VibeLang form panicked the language server", agent: "Claude Code", started: "Oct 16, 2:02 pm", status: "done", activeStage: 6, stages: [
        { label: "Admitted", summary: "1 of 3 machines", log: ["queue: admitted at position 1"], duration: "1 s" },
        { label: "Allocating a machine", summary: "Allocated mm-3 · 4 vCPU", log: ["machine mm-3 claimed"], duration: "7 s" },
        { label: "Cloning", summary: "Cloned effeck/effeck at 3c9d2e1", log: ["fetch depth 1"], duration: "9 s" },
        { label: "Model working", summary: "Claude Code edited the hover walker", log: ["read typescript/vibelang hover sources", "wrote the LSP hover suite case"], duration: "4 m 40 s" },
        { label: "Verifying", summary: "smoke cases · 212 passed", log: ["vibelang smoke: 212 passed, 0 failed"], duration: "1 m 48 s" },
        { label: "Change on main", summary: "7e2c4a1 on main", log: ["main pushed to both remotes"], duration: "3 s" }
      ] }
    ],
    answers: [
      { q: "How do typed errors work?", disclosure: "Worked for 5 s · Read 3 files", files: [
        { path: "examples/users/src/main.vibe", label: "main.vibe:6" },
        { path: "examples/users/src/main.vibe", label: "main.vibe:38-44" },
        { path: "README.md", label: "README.md" }
      ], md: "Declare one with `error UserNotFound { id: string }` — a tagged error class with readonly fields ([main.vibe:6](smithers.sh/effeck/effeck/blob/main/examples/users/src/main.effeck?L=6)). A function that can fail names it in its contract: `find(id: string): User!UserNotFound`.\n\n`throw new UserNotFound({ id })` fails with it, and `catch` recovers expected failures, as `greet` does ([main.vibe:38-44](smithers.sh/effeck/effeck/blob/main/examples/users/src/main.effeck?L=38-44)). An expected failure you don't handle stays in the contract, so callers see it." },
      { q: "How do I call an npm package?", disclosure: "Worked for 6 s · Read 2 files", files: [
        { path: "packages/runtime/src/hatches.ts", label: "hatches.ts:42-47" },
        { path: "packages/runtime/src/hatches.ts", label: "hatches.ts:21-25" }
      ], md: "Plain functions from other packages need a boundary hatch. `try((text) => JSON.parse(text), text)` runs `JSON.parse` as an expected failure you can `catch` ([hatches.ts:42-47](smithers.sh/effeck/effeck/blob/main/packages/runtime/src/hatches.ts?L=42-47)); `sync((n) => n * 2, count)` runs a call that can't fail ([hatches.ts:21-25](smithers.sh/effeck/effeck/blob/main/packages/runtime/src/hatches.ts?L=21-25)).\n\nEffect's own packages are trusted and need no hatch. Inside a hatch, `throw`, `async` and `await` keep their JavaScript meaning." },
      { q: "What does the converter handle?", disclosure: "Worked for 4 s · Read 2 files", files: [
        { path: ".smithers/home.json", label: "home.json" },
        { path: "README.md", label: "README.md" }
      ], md: "Services, typed errors, layers, schedules and streams. The input is one file, at most 8 KiB, and it must import from `effect`.\n\nThe converter on [effeck.dev](effeck.dev/) makes one model call, then the real `vibelang` compiler checks the result. \"Compiles\" means `vibelang --noEmit` passed with the pinned compiler — not that behavior is identical. The guides start at [Onboarding](effeck.dev/001-onboarding.html)." }
    ],
    memberButtons: false
  },

  "effeck/effeck-example": {
    slug: "effeck/effeck-example",
    site: "effeck",
    description: "A runnable VibeLang starter: a typed error, a service and a retry.",
    license: "MIT",
    github: null,
    lastChange: "2 days ago",
    text: "The smallest VibeLang program: one function and one log, ready to run.",
    askTitle: "Ask about this example",
    askPlaceholder: "Ask about this example…",
    visitorChips: ["What does this example show?", "How do I run it?"],
    memberChips: ["Fix an issue", "Review a change", "Ask the codebase"],
    links: [],
    fixed: [],
    tree: {
      "": [
        { name: "src", kind: "dir", note: "main.vibe", age: "2 days ago" },
        { name: "expected-output.txt", kind: "file", note: "Hello, VibeLang!", age: "2 days ago" },
        { name: "package.json", kind: "file", note: "", age: "2 days ago" },
        { name: "README.md", kind: "file", note: "", age: "2 days ago" },
        { name: "tsconfig.json", kind: "file", note: "", age: "2 days ago" }
      ],
      "src": [
        { name: "main.vibe", kind: "file", note: "one function and one log", age: "2 days ago" }
      ]
    },
    dirReadmes: {},
    files: {
      "README.md": { content: EXAMPLE_README, lang: "md" },
      "src/main.vibe": { content: EXAMPLE_MAIN_EFFECK, lang: "ts" },
      "package.json": { content: EXAMPLE_PACKAGE_JSON, lang: "json" },
      "tsconfig.json": { content: EXAMPLE_TSCONFIG, lang: "json" },
      "expected-output.txt": { content: EXAMPLE_EXPECTED, lang: "txt" }
    },
    readme: EXAMPLE_README,
    issues: [
      { n: 2, title: "start script exits 1 on Windows with npm", state: "open", labels: ["bug"], author: "cora", opened: "1 day ago", body: "`npm start` on Windows can't find the compiled output; the build writes `dist/main.js` but npm's script shell resolves `./dist` differently.", comments: [] }
    ],
    pulls: [],
    runs: [],
    answers: [
      { q: "What does this example show?", disclosure: "Worked for 3 s · Read 2 files", files: [
        { path: "src/main.vibe", label: "main.vibe:1-3" },
        { path: "README.md", label: "README.md" }
      ], md: "The smallest VibeLang program: one exported `main` that logs once ([main.vibe:1-3](smithers.sh/effeck/effeck-example/blob/main/src/main.effeck?L=1-3)). The compiler ends the emitted `main.js` with a `NodeRuntime.runMain` guard, so importing the module runs nothing — running it prints `Hello, VibeLang!`." },
      { q: "How do I run it?", disclosure: "Worked for 3 s · Read 1 file", files: [{ path: "README.md", label: "README.md" }], md: "```sh\nnpm create vibelang@latest my-app\ncd my-app\nnpm install\nnpm start\n```\n\nYou need Node 26 or later and Bun 1.4 or later." }
    ],
    memberButtons: false
  },

  "smithersai/hello-smithers": {
    slug: "smithersai/hello-smithers",
    site: "smithers",
    description: "Template: a TypeScript greeting function and its tests, for trying Smithers.",
    license: "MIT",
    github: "https://github.com/smithersai/hello-smithers",
    lastChange: "3 days ago",
    text: "A greeting function with tests. Copy it, ask for a change, merge the pull request.",
    askTitle: "Ask about this repo",
    askPlaceholder: "Ask about this repo…",
    visitorChips: ["What does this repo show?", "How do the tests run?"],
    memberChips: ["Fix an issue", "Review a change", "Ask the codebase"],
    links: [],
    fixed: [],
    tree: {
      "": [
        { name: "src", kind: "dir", note: "greet.ts", age: "3 days ago" },
        { name: "test", kind: "dir", note: "greet.test.ts", age: "3 days ago" },
        { name: "package.json", kind: "file", note: "", age: "3 days ago" },
        { name: "README.md", kind: "file", note: "", age: "3 days ago" }
      ],
      "src": [{ name: "greet.ts", kind: "file", note: "the greeting function", age: "3 days ago" }],
      "test": [{ name: "greet.test.ts", kind: "file", note: "bun:test coverage", age: "3 days ago" }]
    },
    dirReadmes: {},
    files: {
      "README.md": { content: HELLO_README, lang: "md" },
      "src/greet.ts": { content: GREET_TS, lang: "ts" },
      "test/greet.test.ts": { content: GREET_TEST_TS, lang: "ts" },
      "package.json": { content: HELLO_PACKAGE_JSON, lang: "json" }
    },
    readme: HELLO_README,
    issues: [
      { n: 1, title: "greet: add a Spanish greeting", state: "open", labels: [], author: "will", opened: "3 days ago", body: "`greet(name)` only speaks English. Add `greetEs(name)` returning \"¡Hola, <name>!\" with tests.", comments: [] }
    ],
    pulls: [],
    runs: [],
    answers: [
      { q: "What does this repo show?", disclosure: "Worked for 3 s · Read 2 files", files: [
        { path: "src/greet.ts", label: "greet.ts:1-4" },
        { path: "test/greet.test.ts", label: "greet.test.ts:1-10" }
      ], md: "The smallest real change loop. `greet(name)` returns a greeting ([greet.ts:1-4](smithers.sh/smithersai/hello-smithers/blob/main/src/greet.ts?L=1-4)) with bun:test coverage ([greet.test.ts:1-10](smithers.sh/smithersai/hello-smithers/blob/main/test/greet.test.ts?L=1-10)). Make your copy, ask Smithers to add Spanish greetings, and merge the pull request it opens." }
    ],
    memberButtons: false
  },

  "maya/tinyhttp": {
    slug: "maya/tinyhttp",
    site: "smithers",
    description: "A 400-line HTTP router for Bun and Node.",
    license: "MIT",
    github: "https://github.com/maya/tinyhttp",
    lastChange: "2 hours ago",
    text: "",
    askTitle: "What should we work on?",
    askPlaceholder: "Ask for a change…",
    visitorChips: [],
    memberChips: ["Fix an issue", "Review a change", "Ask the codebase"],
    links: [],
    fixed: [],
    tree: {
      "": [
        { name: "src", kind: "dir", note: "router.ts and query.ts", age: "2 days ago" },
        { name: "test", kind: "dir", note: "query and router coverage", age: "yesterday" },
        { name: "package.json", kind: "file", note: "", age: "5 days ago" },
        { name: "README.md", kind: "file", note: "", age: "5 days ago" }
      ],
      "src": [
        { name: "query.ts", kind: "file", note: "the query parser", age: "yesterday" },
        { name: "router.ts", kind: "file", note: "the router", age: "2 days ago" }
      ],
      "test": [{ name: "query.test.ts", kind: "file", note: "query parser coverage", age: "yesterday" }]
    },
    dirReadmes: {},
    files: {
      "README.md": { content: TINYHTTP_README, lang: "md" },
      "src/router.ts": { content: ROUTER_TS, lang: "ts" },
      "src/query.ts": { content: QUERY_TS, lang: "ts" },
      "test/query.test.ts": { content: QUERY_TEST_TS, lang: "ts" },
      "package.json": { content: TINYHTTP_PACKAGE_JSON, lang: "json" }
    },
    readme: TINYHTTP_README,
    issues: [
      { n: 11, title: "Empty query values (?a=) parse to undefined instead of an empty string", state: "open", labels: ["bug"], author: "maya", opened: "3 days ago", body: "`parseQuery(\"?a=\")` returns `{}` — the `a` key is dropped. A form that submits an empty field can't be told apart from one that never sent it.\n\nExpected: `{ a: \"\" }`.", comments: [] },
      { n: 8, title: "Router matched /users before /users/:id", state: "closed", labels: ["bug"], author: "maya", opened: "2 weeks ago", body: "Registration order decided ties; the static route lost to the param route registered first.", comments: [] }
    ],
    pulls: [
      { n: 12, title: "Parse empty query values as empty strings", state: "open", branch: "smithers/empty-query-values", forWho: "maya", opened: "just now", fixes: 11, commit: { sha: "9c1e2ab", subject: "fix: parse empty query values as empty strings" }, checks: [
        { name: "Typecheck", ok: true, detail: "12 s" },
        { name: "Unit tests", ok: true, detail: "34 s · 31 passed" },
        { name: "Lint", ok: true, detail: "8 s" }
      ], additions: 14, deletions: 2, summary: "`parseQuery` dropped a key whose value was empty, so `?a=` and a missing `a` looked the same. An empty value now parses to `\"\"`, and a key with no `=` at all is still dropped. Two tests pin both cases.", findings: [
        { file: "src/query.ts", line: 9, text: "A bare key (`?a`) is still dropped; only `?a=` becomes an empty string." },
        { file: "test/query.test.ts", line: 17, text: "The new test covers `?a=` beside a normal pair." }
      ], diff: [
        { path: "src/query.ts", lines: [
          { kind: "hunk", text: "@@ -3,11 +3,15 @@ export function parseQuery(input: string): Record<string, string> {" },
          { kind: "ctx", old: 3, new: 3, text: "  const params: Record<string, string> = {}" },
          { kind: "ctx", old: 4, new: 4, text: "  for (const pair of input.split(\"&\")) {" },
          { kind: "ctx", old: 5, new: 5, text: "    if (pair === \"\") continue" },
          { kind: "ctx", old: 6, new: 6, text: "    const eq = pair.indexOf(\"=\")" },
          { kind: "del", old: 7, text: "    if (eq === -1) continue" },
          { kind: "del", old: 8, text: "    params[decode(pair.slice(0, eq))] = decode(pair.slice(eq + 1))" },
          { kind: "add", new: 7, text: "    if (eq === -1) continue" },
          { kind: "add", new: 8, text: "    const key = decode(pair.slice(0, eq))" },
          { kind: "add", new: 9, text: "    const raw = pair.slice(eq + 1)" },
          { kind: "add", new: 10, text: "    params[key] = raw === \"\" ? \"\" : decode(raw)" },
          { kind: "ctx", old: 9, new: 11, text: "  }" },
          { kind: "ctx", old: 10, new: 12, text: "  return params" },
          { kind: "ctx", old: 11, new: 13, text: "}" }
        ] },
        { path: "test/query.test.ts", lines: [
          { kind: "hunk", text: "@@ -15,3 +15,9 @@ test(\"round-trips through buildQuery\", () => {" },
          { kind: "ctx", old: 15, new: 15, text: "  expect(parseQuery(buildQuery({ a: \"1\", b: \"/x\" }))).toEqual({ a: \"1\", b: \"/x\" })" },
          { kind: "ctx", old: 16, new: 16, text: "})" },
          { kind: "add", new: 17, text: "" },
          { kind: "add", new: 18, text: "test(\"parses an empty value as an empty string\", () => {" },
          { kind: "add", new: 19, text: "  expect(parseQuery(\"?a=&b=2\")).toEqual({ a: \"\", b: \"2\" })" },
          { kind: "add", new: 20, text: "})" },
          { kind: "add", new: 21, text: "" },
          { kind: "add", new: 22, text: "test(\"drops a bare key\", () => {" },
          { kind: "add", new: 23, text: "  expect(parseQuery(\"?a&b=2\")).toEqual({ b: \"2\" })" },
          { kind: "add", new: 24, text: "})" }
        ] }
      ] },
      { n: 9, title: "Parse plus as space in query values", state: "merged", branch: "maya/query-plus", forWho: "maya", opened: "1 week ago", commit: { sha: "b52d0e7", subject: "fix: decode plus as space in query values" }, checks: [
        { name: "Typecheck", ok: true, detail: "11 s" },
        { name: "Unit tests", ok: true, detail: "30 s · 27 passed" },
        { name: "Lint", ok: true, detail: "7 s" }
      ], additions: 6, deletions: 1, summary: "Query values decoded `%20` but not `+`.", findings: [], diff: [], mergedSha: "b52d0e7" }
    ],
    runs: [
      { id: "run-512", title: "Fix #11: parse empty query values as empty strings", agent: "Claude Code", started: "3 minutes ago", status: "running", activeStage: 3, stages: [
        { label: "Admitted", summary: "1 of 3 machines", log: ["queue: admitted at position 1", "reservation: maya (Claude Code)"], duration: "1 s" },
        { label: "Allocating a machine", summary: "Allocated mm-4 · 2 vCPU", log: ["machine mm-4 claimed", "image smithers-worker:2026.10.15"], duration: "8 s" },
        { label: "Cloning", summary: "Cloned maya/tinyhttp at a41c9e0", log: ["fetch depth 1", "checkout main"], duration: "3 s" },
        { label: "Model working", summary: "Claude Code wrote test/query.test.ts · 14 tests", log: ["read src/query.ts", "read test/query.test.ts", "wrote src/query.ts (+4 −2)"], duration: "1 m 44 s" },
        { label: "Verifying", summary: "bun test · 31 passed", log: ["typecheck ok", "bun test: 31 passed, 0 failed", "lint ok"], duration: "38 s" },
        { label: "Pull request opened", summary: "Opened #12", log: ["branch smithers/empty-query-values", "commit 9c1e2ab"], duration: "2 s" }
      ] }
    ],
    answers: [
      { q: "Ask the codebase", disclosure: "Worked for 4 s · Read 3 files", files: [
        { path: "src/router.ts", label: "router.ts:21-63" },
        { path: "src/query.ts", label: "query.ts:1-12" },
        { path: "README.md", label: "README.md" }
      ], md: "tinyhttp is one `Router` class ([router.ts:21-63](smithers.sh/maya/tinyhttp/blob/main/src/router.ts?L=21-63)) over a query parser ([query.ts:1-12](smithers.sh/maya/tinyhttp/blob/main/src/query.ts?L=1-12)). Routes match by method and segment count, `:param` segments fill `req.params`, and handlers return a `Response`.\n\nOpen work: #11, empty query values parse to `undefined`. Say \"Fix an issue\" and I'll pick it up." }
    ],
    memberButtons: true
  },

  "maya/notes-api": {
    slug: "maya/notes-api",
    site: "smithers",
    description: "Markdown notes over a small REST API.",
    license: "MIT",
    github: "https://github.com/maya/notes-api",
    lastChange: "3 days ago",
    text: "",
    askTitle: "What should we work on?",
    askPlaceholder: "Ask for a change…",
    visitorChips: [],
    memberChips: ["Fix an issue", "Review a change", "Ask the codebase"],
    links: [],
    fixed: [],
    tree: {
      "": [
        { name: "src", kind: "dir", note: "server.ts", age: "3 days ago" },
        { name: "README.md", kind: "file", note: "", age: "3 days ago" }
      ],
      "src": [{ name: "server.ts", kind: "file", note: "the notes API", age: "3 days ago" }]
    },
    dirReadmes: {},
    files: {
      "README.md": { content: NOTES_API_README, lang: "md" },
      "src/server.ts": { content: NOTES_SERVER_TS, lang: "ts" }
    },
    readme: NOTES_API_README,
    issues: [],
    pulls: [],
    runs: [],
    answers: [],
    memberButtons: true
  }
}

REPOS["maya/hello-smithers"] = { ...REPOS["smithersai/hello-smithers"], slug: "maya/hello-smithers", github: "https://github.com/maya/hello-smithers", lastChange: "just now", askTitle: "What should we work on?", askPlaceholder: "Ask for a change…", visitorChips: [], memberChips: ["Fix an issue", "Review a change", "Ask the codebase"], memberButtons: true, answers: [] }
REPOS["maya/effeck-example"] = { ...REPOS["effeck/effeck-example"], slug: "maya/effeck-example", github: "https://github.com/maya/effeck-example", lastChange: "just now", askTitle: "What should we work on?", askPlaceholder: "Ask for a change…", visitorChips: [], memberChips: ["Fix an issue", "Review a change", "Ask the codebase"], memberButtons: true, answers: [] }

const stubStages = (model: string): Stage[] => [
  { label: "Admitted", summary: "1 of 3 machines", log: ["queue: admitted at position 1"], duration: "1 s" },
  { label: "Allocating a machine", summary: "Allocated mm-1 · 4 vCPU", log: ["machine mm-1 claimed"], duration: "8 s" },
  { label: "Cloning", summary: "Cloned at main", log: ["fetch depth 1"], duration: "6 s" },
  { label: "Model working", summary: `${model} wrote the fix and its test`, log: ["read the failing path", "wrote the fix", "wrote the regression test"], duration: "2 m 58 s" },
  { label: "Verifying", summary: "typecheck, tests and lint pass", log: ["typecheck ok", "tests passed", "lint ok"], duration: "2 m 12 s" },
  { label: "Pull request opened", summary: "Opened the change", log: ["branch pushed"], duration: "3 s" }
]

REPOS["effeck/effeck"].files["typescript/README.md"] = {"content": "\n# TypeScript\n\n[![CI](https://github.com/microsoft/TypeScript/actions/workflows/ci.yml/badge.svg)](https://github.com/microsoft/TypeScript/actions/workflows/ci.yml)\n[![npm version](https://badge.fury.io/js/typescript.svg)](https://www.npmjs.com/package/typescript)\n[![Downloads](https://img.shields.io/npm/dm/typescript.svg)](https://www.npmjs.com/package/typescript)\n[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/microsoft/TypeScript/badge)](https://securityscorecards.dev/viewer/?uri=github.com/microsoft/TypeScript)\n\n\n[TypeScript](https://www.typescriptlang.org/) is a language for application-scale JavaScript. TypeScript adds optional types to JavaScript that support tools for large-scale JavaScript applications for any browser, for any host, on any OS. TypeScript compiles to readable, standards-based JavaScript. Try it out at the [playground](https://www.typescriptlang.org/play/), and stay up to date via [our blog](https://devblogs.microsoft.com/typescript/) and [Twitter account](https://twitter.com/typescript).\n\nFind others who are using TypeScript at [our community page](https://www.typescriptlang.org/community/).\n\n## Installing\n\nFor the latest stable version:\n\n```bash\nnpm install -D typescript\n```\n\nFor our nightly builds:\n\n```bash\nnpm install -D typescript@next\n```\n\n## Contribute\n\nThere are many ways to [contribute](CONTRIBUTING.md) to TypeScript.\n* [Submit bugs](https://github.com/microsoft/TypeScript/issues) and help us verify fixes as they are checked in.\n* Review the [source code changes](https://github.com/microsoft/TypeScript/pulls).\n* Engage with other TypeScript users and developers on [StackOverflow](https://stackoverflow.com/questions/tagged/typescript).\n* Help each other in the [TypeScript Community Discord](https://discord.gg/typescript).\n* Join the [#typescript](https://twitter.com/search?q=%23TypeScript) discussion on Twitter.\n* [Contribute bug fixes](CONTRIBUTING.md).\n\nThis project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see\nthe [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com)\nwith any additional questions or comments.\n\n## Documentation\n\n*  [TypeScript in 5 minutes](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html)\n*  [Programming handbook](https://www.typescriptlang.org/docs/handbook/intro.html)\n*  [Homepage](https://www.typescriptlang.org/)\n\n## Roadmap\n\nFor details on our planned features and future direction, please refer to our [roadmap](https://github.com/microsoft/TypeScript/wiki/Roadmap).\n", "lang": "md"}
for (const repo of Object.values(REPOS)) {
  for (const issue of repo.issues) {
    const receipt = issue.receipt
    if (receipt === undefined) continue
    if (receipt.run !== undefined && !repo.runs.some(run => run.id === receipt.run)) {
      repo.runs.push({ id: receipt.run, title: `Fix #${issue.n}: ${issue.title.charAt(0).toLowerCase()}${issue.title.slice(1)}`, agent: receipt.agent ?? "Claude Code", started: receipt.accepted ?? "2 days ago", status: "done", activeStage: 5, stages: stubStages(receipt.agent ?? "Claude Code") })
    }
    if (receipt.pull !== undefined && !repo.pulls.some(pull => pull.n === receipt.pull)) {
      repo.pulls.push({ n: receipt.pull, title: `Fix #${issue.n}: ${issue.title.charAt(0).toLowerCase()}${issue.title.slice(1)}`, state: "merged", branch: `smithers/fix-${issue.n}`, forWho: receipt.acceptedBy ?? "will", opened: receipt.accepted ?? "2 days ago", fixes: issue.n, commit: { sha: receipt.commit ?? "0000000", subject: `fix: ${issue.title.charAt(0).toLowerCase()}${issue.title.slice(1)}` }, checks: [
        { name: "Typecheck", ok: true, detail: "40 s" },
        { name: "Unit tests", ok: true, detail: "2 m 01 s · passed" },
        { name: "Lint", ok: true, detail: "16 s" }
      ], additions: 12, deletions: 3, summary: "Reproduced the report, fixed the cause, and pinned it with a regression test.", findings: [], diff: [], mergedSha: receipt.commit })
    }
  }
}

export const GENERIC_ANSWER = (repo: RepoData): Answer => ({
  q: "",
  disclosure: "Worked for 4 s · Read 2 files",
  files: [{ path: "README.md", label: "README.md" }],
  md: `I answer from this repo's README and docs, and that one's outside them. The [README](smithers.sh/${repo.slug}/blob/main/README.md) is the best starting point${repo.site === "smithers" ? ", and the [docs](smithers.sh/docs) cover installing and running Smithers" : ", and the [docs](effeck.dev/001-onboarding.html) cover the language"}.`
})

export const CHANGE_REQUEST_ANSWER = "Changes need an account. Sign in with GitHub to open your own repo."

export const isChangeRequest = (text: string) => /\b(fix|add|change|implement|update|refactor|remove|write|build|create)\b/i.test(text)

/* Restored round 3 fixtures, from the checkout and VibeLang docs. */
Object.assign(REPOS["smithers-canary/smithers"].files, {
  "apps/app/package.json": {
    "content": "{\n  \"name\": \"smithers-app\",\n  \"private\": true,\n  \"version\": \"1.0.0\",\n  \"description\": \"Smithers browser app\",\n  \"scripts\": {\n    \"start\": \"bun src/bun/serve.ts\",\n    \"dev\": \"vite --configLoader runner\",\n    \"build:web\": \"vite build --configLoader runner\",\n    \"build\": \"pnpm run build:web\",\n    \"typecheck\": \"tsc --noEmit\",\n    \"check\": \"tsc --noEmit\",\n    \"test\": \"smthrs test //apps/app:unitTests\",\n    \"lint:conformance\": \"bun test lint/conformance\",\n    \"checklist\": \"bun scripts/launch-checklist.ts\",\n    \"test:e2e\": \"playwright test\",\n    \"test:e2e:real\": \"bun scripts/run-real-e2e.ts\",\n    \"test:e2e:matrix\": \"bun scripts/run-mode-matrix.ts run\",\n    \"showcase\": \"bun scripts/showcase.ts\",\n    \"test:e2e:site\": \"playwright test --config playwright.site.config.ts\",\n    \"test:e2e:auth\": \"bun test e2e/native/CloudAuthFragment.test.ts\",\n    \"test:e2e:probes\": \"bun test e2e/probes\",\n    \"test:e2e:graph-lifecycle\": \"bun test e2e/graph/lifecycle\",\n    \"proof:gateway\": \"tsx scripts/gateway-run-proof.ts\",\n    \"local:no-github\": \"bun scripts/run-local-no-github.ts\",\n    \"test:e2e:local\": \"playwright test --config playwright.local.config.ts\",\n    \"test:e2e:proof\": \"playwright test --config playwright.proof.config.ts\"\n  },\n  \"dependencies\": {\n    \"@fontsource/ibm-plex-mono\": \"5.3.0\",\n    \"@fontsource/inter\": \"5.3.0\",\n    \"@journeyapps/wa-sqlite\": \"1.7.2\",\n    \"@smthrs/canonical\": \"workspace:*\",\n    \"@smthrs/capability\": \"workspace:*\",\n    \"@smthrs/chain\": \"workspace:*\",\n    \"@smthrs/core\": \"workspace:*\",\n    \"@smthrs/crypto\": \"workspace:*\",\n    \"@smthrs/database\": \"workspace:*\",\n    \"@smthrs/engine-store\": \"workspace:*\",\n    \"@smthrs/flow\": \"workspace:*\",\n    \"@smthrs/gateway\": \"workspace:*\",\n    \"@smthrs/harness\": \"workspace:*\",\n    \"@smthrs/harness-detect\": \"workspace:*\",\n    \"@smthrs/jj\": \"workspace:*\",\n    \"@smthrs/journal\": \"workspace:*\",\n    \"@smthrs/kernel\": \"workspace:*\",\n    \"@smthrs/memory\": \"workspace:*\",\n    \"@smthrs/model\": \"workspace:*\",\n    \"@smthrs/model-host\": \"workspace:*\",\n    \"@smthrs/patterns\": \"workspace:*\",\n    \"@smthrs/platform-browser\": \"workspace:*\",\n    \"@smthrs/registry\": \"workspace:*\",\n    \"@smthrs/rpc\": \"workspace:*\",\n    \"@smthrs/ui\": \"workspace:*\",\n    \"@standard-schema/spec\": \"1.1.0\",\n    \"@tanstack/browser-db-sqlite-persistence\": \"0.2.20\",\n    \"@tanstack/db\": \"0.8.7\",\n    \"@tanstack/react-db\": \"0.3.7\",\n    \"@xyflow/react\": \"^12.11.6\",\n    \"dagre\": \"^0.8.5\",\n    \"effect\": \"4.0.5\",\n    \"lucide-react\": \"1.40.0\",\n    \"react\": \"19.2.8\",\n    \"react-dom\": \"19.2.8\",\n    \"yjs\": \"13.6.32\",\n    \"zod\": \"4.5.4\",\n    \"y-protocols\": \"1.0.6\",\n    \"lib0\": \"0.2.114\",\n    \"y-codemirror.next\": \"0.3.6\",\n    \"@codemirror/state\": \"6.7.2\",\n    \"@codemirror/view\": \"6.43.11\",\n    \"@smthrs/cli\": \"workspace:*\"\n  },\n  \"devDependencies\": {\n    \"@effect/platform-node\": \"4.0.5\",\n    \"@happy-dom/global-registrator\": \"^20.13.2\",\n    \"@playwright/test\": \"1.62.1\",\n    \"@smthrs/control\": \"workspace:*\",\n    \"@smthrs/notifications\": \"workspace:*\",\n    \"@smthrs/plan\": \"workspace:*\",\n    \"@smthrs/run-store\": \"workspace:*\",\n    \"@smthrs/sync\": \"workspace:*\",\n    \"@smthrs/testing\": \"workspace:*\",\n    \"@tailwindcss/postcss\": \"4.3.3\",\n    \"@types/bun\": \"latest\",\n    \"@types/d3-force\": \"3.0.10\",\n    \"@types/dagre\": \"0.7.54\",\n    \"@types/react\": \"19.2.18\",\n    \"@types/react-dom\": \"19.2.7\",\n    \"@types/three\": \"0.185.4\",\n    \"@vitejs/plugin-react\": \"6.1.1\",\n    \"autoprefixer\": \"^10.5.4\",\n    \"axe-core\": \"^4.13.0\",\n    \"happy-dom\": \"20.13.2\",\n    \"playwright\": \"1.62.1\",\n    \"postcss\": \"^8.5.28\",\n    \"smithers-server\": \"workspace:*\",\n    \"tailwindcss\": \"^4.3.3\",\n    \"tsx\": \"4.23.13\",\n    \"typescript\": \"^5.9.3\",\n    \"vite\": \"8.2.2\",\n    \"yaml\": \"2.9.0\"\n  }\n}\n",
    "lang": "json"
  },
  "apps/site/package.json": {
    "content": "{\n  \"name\": \"@smithers/site\",\n  \"version\": \"0.0.1\",\n  \"private\": true,\n  \"description\": \"The smithers.sh landing page\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"astro dev\",\n    \"build\": \"astro build && node scripts/check-built-site.mjs\",\n    \"capture:learn\": \"node scripts/journeys/capture.mjs\",\n    \"check\": \"astro check\",\n    \"preview\": \"astro preview\",\n    \"sync:docs\": \"node scripts/sync-support-docs.mjs && node scripts/gen-cli-data.mjs && node scripts/sync-api-docs.mjs && node scripts/ingest-reference.mjs && node scripts/generate-llms.mjs\",\n    \"check:docs\": \"node --test --test-concurrency=1 scripts/support-matrix.test.mjs scripts/docs-text.test.mjs scripts/flows-location.test.mjs scripts/gen-cli-data.test.mjs scripts/migration-guide.test.mjs scripts/install-page.test.mjs scripts/generate-project-copy.test.mjs scripts/built-site.test.mjs scripts/deployment.test.mjs scripts/catalog-publication.test.mjs scripts/check-exit.test.mjs && node scripts/check-docs.mjs && node scripts/gen-cli-data.mjs --check && node scripts/sync-api-docs.mjs --check && node scripts/ingest-reference.mjs --check && node scripts/generate-llms.mjs --check\",\n    \"lint\": \"eslint --no-config-lookup scripts/support-matrix.test.mjs scripts/sync-support-docs.mjs --rule \\\"no-unused-vars:error\\\" && node scripts/check-docs.mjs && node scripts/sync-support-docs.mjs --check\",\n    \"test\": \"node --test --test-concurrency=1 scripts/record-tape.test.mjs scripts/repo-stats.test.mjs scripts/support-matrix.test.mjs scripts/docs-text.test.mjs scripts/flows-location.test.mjs scripts/gen-cli-data.test.mjs scripts/migration-guide.test.mjs scripts/generate-project-copy.test.mjs scripts/install-page.test.mjs scripts/built-site.test.mjs scripts/deployment.test.mjs scripts/demo-form.test.mjs scripts/catalog-publication.test.mjs scripts/site-typecheck.test.mjs scripts/same-origin-url.test.mjs scripts/application-target.test.mjs\"\n  },\n  \"devDependencies\": {\n    \"@astrojs/check\": \"^0.9.10\",\n    \"@effect/platform-node\": \"4.0.5\",\n    \"@effect/platform-node-shared\": \"4.0.5\",\n    \"@smthrs/agent\": \"workspace:*\",\n    \"@smthrs/capability\": \"workspace:*\",\n    \"@smthrs/control\": \"workspace:*\",\n    \"@smthrs/database\": \"workspace:*\",\n    \"@smthrs/engine\": \"workspace:*\",\n    \"@smthrs/engine-store\": \"workspace:*\",\n    \"@smthrs/flow\": \"workspace:*\",\n    \"@smthrs/flows\": \"workspace:*\",\n    \"@smthrs/harness\": \"workspace:*\",\n    \"@smthrs/jj\": \"workspace:*\",\n    \"@smthrs/journal\": \"workspace:*\",\n    \"@smthrs/kernel\": \"workspace:*\",\n    \"@smthrs/mcp\": \"workspace:*\",\n    \"@smthrs/memory\": \"workspace:*\",\n    \"@smthrs/model\": \"workspace:*\",\n    \"@smthrs/observability\": \"workspace:*\",\n    \"@smthrs/plan\": \"workspace:*\",\n    \"@smthrs/platform-node\": \"workspace:*\",\n    \"@smthrs/registry\": \"workspace:*\",\n    \"@smthrs/rpc\": \"workspace:*\",\n    \"@smthrs/run-store\": \"workspace:*\",\n    \"@smthrs/sandbox\": \"workspace:*\",\n    \"@smthrs/std\": \"workspace:*\",\n    \"@smthrs/sync\": \"workspace:*\",\n    \"@smthrs/testing\": \"workspace:*\",\n    \"@smthrs/time-travel\": \"workspace:*\",\n    \"@types/react\": \"^19.2.18\",\n    \"effect\": \"4.0.5\",\n    \"typescript\": \"~5.9.3\"\n  },\n  \"dependencies\": {\n    \"@astrojs/react\": \"^6.0.5\",\n    \"@astrojs/starlight\": \"^0.42.0\",\n    \"@shikijs/themes\": \"^4.4.3\",\n    \"@tailwindcss/vite\": \"^4.3.3\",\n    \"astro\": \"^7.3.1\",\n    \"react\": \"19.2.8\",\n    \"react-dom\": \"19.2.8\"\n  }\n}\n",
    "lang": "json"
  },
  "packages/smithers/package.json": {
    "content": "{\n  \"name\": \"@smthrs/cli\",\n  \"type\": \"module\",\n  \"version\": \"1.0.0-rc.14\",\n  \"license\": \"MIT\",\n  \"smthrs\": {\n    \"group\": \"agent\",\n    \"privateEffectAdapters\": [\n      \"@effect/platform-bun\",\n      \"@effect/platform-node\",\n      \"@effect/platform-node-shared\"\n    ]\n  },\n  \"description\": \"Node command-line interface for Smithers control\",\n  \"homepage\": \"https://github.com/smithersai/smithers\",\n  \"repository\": {\n    \"type\": \"git\",\n    \"url\": \"https://github.com/smithersai/smithers.git\",\n    \"directory\": \"packages/smithers\"\n  },\n  \"bugs\": {\n    \"url\": \"https://github.com/smithersai/smithers/issues\"\n  },\n  \"tags\": [\n    \"typescript\",\n    \"effect\",\n    \"cli\",\n    \"flow\"\n  ],\n  \"keywords\": [\n    \"typescript\",\n    \"effect\",\n    \"cli\",\n    \"flow\"\n  ],\n  \"engines\": {\n    \"node\": \">=26.4.0\"\n  },\n  \"sideEffects\": [\n    \"./src/bin.ts\",\n    \"./src/cli/LegacyBin.ts\",\n    \"./src/Version.ts\",\n    \"./dist/esm/bin.js\",\n    \"./dist/esm/cli/LegacyBin.js\",\n    \"./dist/esm/Version.js\",\n    \"./dist/cjs/bin.js\",\n    \"./dist/cjs/cli/LegacyBin.js\",\n    \"./dist/cjs/Version.js\"\n  ],\n  \"bin\": {\n    \"smithers\": \"./bin/smithers.mjs\",\n    \"smthrs\": \"./bin/smithers.mjs\"\n  },\n  \"exports\": {\n    \"./package.json\": \"./package.json\",\n    \".\": \"./src/index.ts\",\n    \"./internal/*\": null,\n    \"./*/index\": null,\n    \"./McpServer\": null,\n    \"./Agents\": \"./src/Agents.ts\",\n    \"./Application\": \"./src/Application.ts\",\n    \"./Audience\": \"./src/Audience.ts\",\n    \"./Bug\": \"./src/Bug.ts\",\n    \"./BunControl\": \"./src/BunControl.ts\",\n    \"./ClaudeMirror\": \"./src/ClaudeMirror.ts\",\n    \"./Cli\": \"./src/Cli.ts\",\n    \"./CliError\": \"./src/CliError.ts\",\n    \"./CodexAuth\": null,\n    \"./Command\": \"./src/Command.ts\",\n    \"./Detached\": \"./src/Detached.ts\",\n    \"./Doctor\": \"./src/Doctor.ts\",\n    \"./Environment\": \"./src/Environment.ts\",\n    \"./ExecutionEnvironment\": \"./src/ExecutionEnvironment.ts\",\n    \"./ExecutorOwnership\": \"./src/ExecutorOwnership.ts\",\n    \"./Forensics\": \"./src/Forensics.ts\",\n    \"./Gc\": \"./src/Gc.ts\",\n    \"./Init\": \"./src/Init.ts\",\n    \"./Legacy\": \"./src/Legacy.ts\",\n    \"./NodeControl\": \"./src/NodeControl.ts\",\n    \"./NodeOutput\": \"./src/NodeOutput.ts\",\n    \"./Output\": \"./src/Output.ts\",\n    \"./Project\": \"./src/Project.ts\",\n    \"./Providers\": \"./src/Providers.ts\",\n    \"./CloudSession\": \"./src/CloudSession.ts\",\n    \"./Serve\": \"./src/Serve.ts\",\n    \"./Suggest\": \"./src/Suggest.ts\",\n    \"./Ui\": \"./src/Ui.ts\",\n    \"./Unsupported\": \"./src/Unsupported.ts\",\n    \"./Update\": \"./src/Update.ts\",\n    \"./Verb\": \"./src/Verb.ts\",\n    \"./Version\": \"./src/Version.ts\",\n    \"./bin\": \"./src/bin.ts\",\n    \"./cli/Arguments\": \"./src/cli/Arguments.ts\",\n    \"./cli/Compatibility\": \"./src/cli/Compatibility.ts\",\n    \"./cli/ControlBridge\": \"./src/cli/ControlBridge.ts\",\n    \"./cli/ControlCommands\": \"./src/cli/ControlCommands.ts\",\n    \"./cli/Entry\": \"./src/cli/Entry.ts\",\n    \"./cli/EnvironmentCommands\": \"./src/cli/EnvironmentCommands.ts\",\n    \"./cli/Generate\": \"./src/cli/Generate.ts\",\n    \"./cli/HistoryCommands\": \"./src/cli/HistoryCommands.ts\",\n    \"./cli/LegacyBin\": \"./src/cli/LegacyBin.ts\",\n    \"./cli/Presentation\": \"./src/cli/Presentation.ts\",\n    \"./cli/RunProgress\": \"./src/cli/RunProgress.ts\",\n    \"./cli/TokenCommands\": \"./src/cli/TokenCommands.ts\",\n    \"./evaluation/EvalCli\": \"./src/evaluation/EvalCli.ts\",\n    \"./evaluation/Evaluation\": \"./src/evaluation/Evaluation.ts\",\n    \"./history/History\": \"./src/history/History.ts\",\n    \"./history/ExecutionTarget\": \"./src/history/ExecutionTarget.ts\",\n    \"./history/Workspace\": \"./src/history/Workspace.ts\",\n    \"./index\": \"./src/index.ts\",\n    \"./operator/Credentials\": \"./src/operator/Credentials.ts\",\n    \"./operator/Integrations\": \"./src/operator/Integrations.ts\",\n    \"./operator/Memory\": \"./src/operator/Memory.ts\",\n    \"./operator/Store\": \"./src/operator/Store.ts\",\n    \"./operator/TriggerPlans\": \"./src/operator/TriggerPlans.ts\",\n    \"./operator/Triggers\": \"./src/operator/Triggers.ts\",\n    \"./suggest/Brief\": \"./src/suggest/Brief.ts\",\n    \"./suggest/Checklist\": \"./src/suggest/Checklist.ts\",\n    \"./suggest/SuggestFlow\": \"./src/suggest/SuggestFlow.ts\",\n    \"./CloudSandbox\": \"./src/CloudSandbox.ts\",\n    \"./tui-native\": {\n      \"types\": \"./vendor/opentui-native/runtime.d.ts\",\n      \"bun\": \"./vendor/opentui-native/runtime.bun.mjs\",\n      \"default\": \"./vendor/opentui-native/runtime.node.mjs\"\n    },\n    \"./CatalogRequest\": \"./src/CatalogRequest.ts\",\n    \"./Catalog\": \"./src/Catalog.ts\",\n    \"./BackendCommands\": \"./src/BackendCommands.ts\",\n    \"./IssueTodoDraft\": \"./src/IssueTodoDraft.ts\"\n  },\n  \"files\": [\n    \"bin/**/*.mjs\",\n    \"src/**/*.ts\",\n    \"skills/**\",\n    \"dist/**/*.js\",\n    \"dist/**/*.js.map\",\n    \"dist/**/*.d.ts\",\n    \"dist/**/*.d.ts.map\",\n    \"dist/**/package.json\",\n    \"dist/**/catalog.mvp.json\",\n    \"LICENSE\",\n    \"README.md\",\n    \"CHANGELOG.md\",\n    \"vendor/opentui-native/**\",\n    \"dist/vendor/**\",\n    \"docs/\"\n  ],\n  \"publishConfig\": {\n    \"access\": \"public\",\n    \"provenance\": true,\n    \"tag\": \"next\",\n    \"exports\": {\n      \"./package.json\": \"./package.json\",\n      \".\": {\n        \"import\": {\n          \"types\": \"./dist/esm/index.d.ts\",\n          \"default\": \"./dist/esm/index.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/index.d.ts\",\n          \"default\": \"./dist/cjs/index.js\"\n        }\n      },\n      \"./internal/*\": null,\n      \"./*/index\": null,\n      \"./McpServer\": null,\n      \"./Agents\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Agents.d.ts\",\n          \"default\": \"./dist/esm/Agents.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Agents.d.ts\",\n          \"default\": \"./dist/cjs/Agents.js\"\n        }\n      },\n      \"./Application\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Application.d.ts\",\n          \"default\": \"./dist/esm/Application.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Application.d.ts\",\n          \"default\": \"./dist/cjs/Application.js\"\n        }\n      },\n      \"./Audience\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Audience.d.ts\",\n          \"default\": \"./dist/esm/Audience.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Audience.d.ts\",\n          \"default\": \"./dist/cjs/Audience.js\"\n        }\n      },\n      \"./Bug\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Bug.d.ts\",\n          \"default\": \"./dist/esm/Bug.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Bug.d.ts\",\n          \"default\": \"./dist/cjs/Bug.js\"\n        }\n      },\n      \"./BunControl\": {\n        \"import\": {\n          \"types\": \"./dist/esm/BunControl.d.ts\",\n          \"default\": \"./dist/esm/BunControl.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/BunControl.d.ts\",\n          \"default\": \"./dist/cjs/BunControl.js\"\n        }\n      },\n      \"./ClaudeMirror\": {\n        \"import\": {\n          \"types\": \"./dist/esm/ClaudeMirror.d.ts\",\n          \"default\": \"./dist/esm/ClaudeMirror.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/ClaudeMirror.d.ts\",\n          \"default\": \"./dist/cjs/ClaudeMirror.js\"\n        }\n      },\n      \"./Cli\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Cli.d.ts\",\n          \"default\": \"./dist/esm/Cli.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Cli.d.ts\",\n          \"default\": \"./dist/cjs/Cli.js\"\n        }\n      },\n      \"./CliError\": {\n        \"import\": {\n          \"types\": \"./dist/esm/CliError.d.ts\",\n          \"default\": \"./dist/esm/CliError.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/CliError.d.ts\",\n          \"default\": \"./dist/cjs/CliError.js\"\n        }\n      },\n      \"./CodexAuth\": null,\n      \"./Command\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Command.d.ts\",\n          \"default\": \"./dist/esm/Command.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Command.d.ts\",\n          \"default\": \"./dist/cjs/Command.js\"\n        }\n      },\n      \"./Detached\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Detached.d.ts\",\n          \"default\": \"./dist/esm/Detached.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Detached.d.ts\",\n          \"default\": \"./dist/cjs/Detached.js\"\n        }\n      },\n      \"./Doctor\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Doctor.d.ts\",\n          \"default\": \"./dist/esm/Doctor.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Doctor.d.ts\",\n          \"default\": \"./dist/cjs/Doctor.js\"\n        }\n      },\n      \"./Environment\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Environment.d.ts\",\n          \"default\": \"./dist/esm/Environment.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Environment.d.ts\",\n          \"default\": \"./dist/cjs/Environment.js\"\n        }\n      },\n      \"./ExecutorOwnership\": {\n        \"import\": {\n          \"types\": \"./dist/esm/ExecutorOwnership.d.ts\",\n          \"default\": \"./dist/esm/ExecutorOwnership.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/ExecutorOwnership.d.ts\",\n          \"default\": \"./dist/cjs/ExecutorOwnership.js\"\n        }\n      },\n      \"./Forensics\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Forensics.d.ts\",\n          \"default\": \"./dist/esm/Forensics.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Forensics.d.ts\",\n          \"default\": \"./dist/cjs/Forensics.js\"\n        }\n      },\n      \"./Gc\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Gc.d.ts\",\n          \"default\": \"./dist/esm/Gc.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Gc.d.ts\",\n          \"default\": \"./dist/cjs/Gc.js\"\n        }\n      },\n      \"./Init\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Init.d.ts\",\n          \"default\": \"./dist/esm/Init.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Init.d.ts\",\n          \"default\": \"./dist/cjs/Init.js\"\n        }\n      },\n      \"./Legacy\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Legacy.d.ts\",\n          \"default\": \"./dist/esm/Legacy.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Legacy.d.ts\",\n          \"default\": \"./dist/cjs/Legacy.js\"\n        }\n      },\n      \"./NodeControl\": {\n        \"import\": {\n          \"types\": \"./dist/esm/NodeControl.d.ts\",\n          \"default\": \"./dist/esm/NodeControl.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/NodeControl.d.ts\",\n          \"default\": \"./dist/cjs/NodeControl.js\"\n        }\n      },\n      \"./NodeOutput\": {\n        \"import\": {\n          \"types\": \"./dist/esm/NodeOutput.d.ts\",\n          \"default\": \"./dist/esm/NodeOutput.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/NodeOutput.d.ts\",\n          \"default\": \"./dist/cjs/NodeOutput.js\"\n        }\n      },\n      \"./Output\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Output.d.ts\",\n          \"default\": \"./dist/esm/Output.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Output.d.ts\",\n          \"default\": \"./dist/cjs/Output.js\"\n        }\n      },\n      \"./Project\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Project.d.ts\",\n          \"default\": \"./dist/esm/Project.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Project.d.ts\",\n          \"default\": \"./dist/cjs/Project.js\"\n        }\n      },\n      \"./Providers\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Providers.d.ts\",\n          \"default\": \"./dist/esm/Providers.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Providers.d.ts\",\n          \"default\": \"./dist/cjs/Providers.js\"\n        }\n      },\n      \"./CloudSession\": {\n        \"import\": {\n          \"types\": \"./dist/esm/CloudSession.d.ts\",\n          \"default\": \"./dist/esm/CloudSession.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/CloudSession.d.ts\",\n          \"default\": \"./dist/cjs/CloudSession.js\"\n        }\n      },\n      \"./Serve\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Serve.d.ts\",\n          \"default\": \"./dist/esm/Serve.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Serve.d.ts\",\n          \"default\": \"./dist/cjs/Serve.js\"\n        }\n      },\n      \"./Suggest\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Suggest.d.ts\",\n          \"default\": \"./dist/esm/Suggest.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Suggest.d.ts\",\n          \"default\": \"./dist/cjs/Suggest.js\"\n        }\n      },\n      \"./Ui\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Ui.d.ts\",\n          \"default\": \"./dist/esm/Ui.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Ui.d.ts\",\n          \"default\": \"./dist/cjs/Ui.js\"\n        }\n      },\n      \"./Unsupported\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Unsupported.d.ts\",\n          \"default\": \"./dist/esm/Unsupported.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Unsupported.d.ts\",\n          \"default\": \"./dist/cjs/Unsupported.js\"\n        }\n      },\n      \"./Update\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Update.d.ts\",\n          \"default\": \"./dist/esm/Update.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Update.d.ts\",\n          \"default\": \"./dist/cjs/Update.js\"\n        }\n      },\n      \"./Verb\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Verb.d.ts\",\n          \"default\": \"./dist/esm/Verb.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Verb.d.ts\",\n          \"default\": \"./dist/cjs/Verb.js\"\n        }\n      },\n      \"./Version\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Version.d.ts\",\n          \"default\": \"./dist/esm/Version.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Version.d.ts\",\n          \"default\": \"./dist/cjs/Version.js\"\n        }\n      },\n      \"./bin\": {\n        \"import\": {\n          \"types\": \"./dist/esm/bin.d.ts\",\n          \"default\": \"./dist/esm/bin.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/bin.d.ts\",\n          \"default\": \"./dist/cjs/bin.js\"\n        }\n      },\n      \"./cli/Arguments\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/Arguments.d.ts\",\n          \"default\": \"./dist/esm/cli/Arguments.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/Arguments.d.ts\",\n          \"default\": \"./dist/cjs/cli/Arguments.js\"\n        }\n      },\n      \"./cli/Compatibility\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/Compatibility.d.ts\",\n          \"default\": \"./dist/esm/cli/Compatibility.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/Compatibility.d.ts\",\n          \"default\": \"./dist/cjs/cli/Compatibility.js\"\n        }\n      },\n      \"./cli/ControlBridge\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/ControlBridge.d.ts\",\n          \"default\": \"./dist/esm/cli/ControlBridge.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/ControlBridge.d.ts\",\n          \"default\": \"./dist/cjs/cli/ControlBridge.js\"\n        }\n      },\n      \"./cli/ControlCommands\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/ControlCommands.d.ts\",\n          \"default\": \"./dist/esm/cli/ControlCommands.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/ControlCommands.d.ts\",\n          \"default\": \"./dist/cjs/cli/ControlCommands.js\"\n        }\n      },\n      \"./cli/Entry\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/Entry.d.ts\",\n          \"default\": \"./dist/esm/cli/Entry.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/Entry.d.ts\",\n          \"default\": \"./dist/cjs/cli/Entry.js\"\n        }\n      },\n      \"./cli/Generate\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/Generate.d.ts\",\n          \"default\": \"./dist/esm/cli/Generate.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/Generate.d.ts\",\n          \"default\": \"./dist/cjs/cli/Generate.js\"\n        }\n      },\n      \"./cli/HistoryCommands\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/HistoryCommands.d.ts\",\n          \"default\": \"./dist/esm/cli/HistoryCommands.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/HistoryCommands.d.ts\",\n          \"default\": \"./dist/cjs/cli/HistoryCommands.js\"\n        }\n      },\n      \"./cli/LegacyBin\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/LegacyBin.d.ts\",\n          \"default\": \"./dist/esm/cli/LegacyBin.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/LegacyBin.d.ts\",\n          \"default\": \"./dist/cjs/cli/LegacyBin.js\"\n        }\n      },\n      \"./cli/Presentation\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/Presentation.d.ts\",\n          \"default\": \"./dist/esm/cli/Presentation.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/Presentation.d.ts\",\n          \"default\": \"./dist/cjs/cli/Presentation.js\"\n        }\n      },\n      \"./cli/RunProgress\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/RunProgress.d.ts\",\n          \"default\": \"./dist/esm/cli/RunProgress.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/RunProgress.d.ts\",\n          \"default\": \"./dist/cjs/cli/RunProgress.js\"\n        }\n      },\n      \"./cli/TokenCommands\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/TokenCommands.d.ts\",\n          \"default\": \"./dist/esm/cli/TokenCommands.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/TokenCommands.d.ts\",\n          \"default\": \"./dist/cjs/cli/TokenCommands.js\"\n        }\n      },\n      \"./evaluation/EvalCli\": {\n        \"import\": {\n          \"types\": \"./dist/esm/evaluation/EvalCli.d.ts\",\n          \"default\": \"./dist/esm/evaluation/EvalCli.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/evaluation/EvalCli.d.ts\",\n          \"default\": \"./dist/cjs/evaluation/EvalCli.js\"\n        }\n      },\n      \"./evaluation/Evaluation\": {\n        \"import\": {\n          \"types\": \"./dist/esm/evaluation/Evaluation.d.ts\",\n          \"default\": \"./dist/esm/evaluation/Evaluation.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/evaluation/Evaluation.d.ts\",\n          \"default\": \"./dist/cjs/evaluation/Evaluation.js\"\n        }\n      },\n      \"./history/History\": {\n        \"import\": {\n          \"types\": \"./dist/esm/history/History.d.ts\",\n          \"default\": \"./dist/esm/history/History.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/history/History.d.ts\",\n          \"default\": \"./dist/cjs/history/History.js\"\n        }\n      },\n      \"./history/ExecutionTarget\": {\n        \"import\": {\n          \"types\": \"./dist/esm/history/ExecutionTarget.d.ts\",\n          \"default\": \"./dist/esm/history/ExecutionTarget.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/history/ExecutionTarget.d.ts\",\n          \"default\": \"./dist/cjs/history/ExecutionTarget.js\"\n        }\n      },\n      \"./history/Workspace\": {\n        \"import\": {\n          \"types\": \"./dist/esm/history/Workspace.d.ts\",\n          \"default\": \"./dist/esm/history/Workspace.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/history/Workspace.d.ts\",\n          \"default\": \"./dist/cjs/history/Workspace.js\"\n        }\n      },\n      \"./index\": {\n        \"import\": {\n          \"types\": \"./dist/esm/index.d.ts\",\n          \"default\": \"./dist/esm/index.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/index.d.ts\",\n          \"default\": \"./dist/cjs/index.js\"\n        }\n      },\n      \"./operator/Credentials\": {\n        \"import\": {\n          \"types\": \"./dist/esm/operator/Credentials.d.ts\",\n          \"default\": \"./dist/esm/operator/Credentials.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/operator/Credentials.d.ts\",\n          \"default\": \"./dist/cjs/operator/Credentials.js\"\n        }\n      },\n      \"./operator/Integrations\": {\n        \"import\": {\n          \"types\": \"./dist/esm/operator/Integrations.d.ts\",\n          \"default\": \"./dist/esm/operator/Integrations.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/operator/Integrations.d.ts\",\n          \"default\": \"./dist/cjs/operator/Integrations.js\"\n        }\n      },\n      \"./operator/Memory\": {\n        \"import\": {\n          \"types\": \"./dist/esm/operator/Memory.d.ts\",\n          \"default\": \"./dist/esm/operator/Memory.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/operator/Memory.d.ts\",\n          \"default\": \"./dist/cjs/operator/Memory.js\"\n        }\n      },\n      \"./operator/Store\": {\n        \"import\": {\n          \"types\": \"./dist/esm/operator/Store.d.ts\",\n          \"default\": \"./dist/esm/operator/Store.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/operator/Store.d.ts\",\n          \"default\": \"./dist/cjs/operator/Store.js\"\n        }\n      },\n      \"./operator/TriggerPlans\": {\n        \"import\": {\n          \"types\": \"./dist/esm/operator/TriggerPlans.d.ts\",\n          \"default\": \"./dist/esm/operator/TriggerPlans.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/operator/TriggerPlans.d.ts\",\n          \"default\": \"./dist/cjs/operator/TriggerPlans.js\"\n        }\n      },\n      \"./operator/Triggers\": {\n        \"import\": {\n          \"types\": \"./dist/esm/operator/Triggers.d.ts\",\n          \"default\": \"./dist/esm/operator/Triggers.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/operator/Triggers.d.ts\",\n          \"default\": \"./dist/cjs/operator/Triggers.js\"\n        }\n      },\n      \"./suggest/Brief\": {\n        \"import\": {\n          \"types\": \"./dist/esm/suggest/Brief.d.ts\",\n          \"default\": \"./dist/esm/suggest/Brief.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/suggest/Brief.d.ts\",\n          \"default\": \"./dist/cjs/suggest/Brief.js\"\n        }\n      },\n      \"./suggest/Checklist\": {\n        \"import\": {\n          \"types\": \"./dist/esm/suggest/Checklist.d.ts\",\n          \"default\": \"./dist/esm/suggest/Checklist.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/suggest/Checklist.d.ts\",\n          \"default\": \"./dist/cjs/suggest/Checklist.js\"\n        }\n      },\n      \"./suggest/SuggestFlow\": {\n        \"import\": {\n          \"types\": \"./dist/esm/suggest/SuggestFlow.d.ts\",\n          \"default\": \"./dist/esm/suggest/SuggestFlow.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/suggest/SuggestFlow.d.ts\",\n          \"default\": \"./dist/cjs/suggest/SuggestFlow.js\"\n        }\n      },\n      \"./ExecutionEnvironment\": {\n        \"import\": {\n          \"types\": \"./dist/esm/ExecutionEnvironment.d.ts\",\n          \"default\": \"./dist/esm/ExecutionEnvironment.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/ExecutionEnvironment.d.ts\",\n          \"default\": \"./dist/cjs/ExecutionEnvironment.js\"\n        }\n      },\n      \"./cli/EnvironmentCommands\": {\n        \"import\": {\n          \"types\": \"./dist/esm/cli/EnvironmentCommands.d.ts\",\n          \"default\": \"./dist/esm/cli/EnvironmentCommands.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/cli/EnvironmentCommands.d.ts\",\n          \"default\": \"./dist/cjs/cli/EnvironmentCommands.js\"\n        }\n      },\n      \"./CloudSandbox\": {\n        \"import\": {\n          \"types\": \"./dist/esm/CloudSandbox.d.ts\",\n          \"default\": \"./dist/esm/CloudSandbox.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/CloudSandbox.d.ts\",\n          \"default\": \"./dist/cjs/CloudSandbox.js\"\n        }\n      },\n      \"./tui-native\": {\n        \"types\": \"./vendor/opentui-native/runtime.d.ts\",\n        \"bun\": \"./vendor/opentui-native/runtime.bun.mjs\",\n        \"default\": \"./vendor/opentui-native/runtime.node.mjs\"\n      },\n      \"./CatalogRequest\": {\n        \"import\": {\n          \"types\": \"./dist/esm/CatalogRequest.d.ts\",\n          \"default\": \"./dist/esm/CatalogRequest.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/CatalogRequest.d.ts\",\n          \"default\": \"./dist/cjs/CatalogRequest.js\"\n        }\n      },\n      \"./Catalog\": {\n        \"import\": {\n          \"types\": \"./dist/esm/Catalog.d.ts\",\n          \"default\": \"./dist/esm/Catalog.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/Catalog.d.ts\",\n          \"default\": \"./dist/cjs/Catalog.js\"\n        }\n      },\n      \"./BackendCommands\": {\n        \"import\": {\n          \"types\": \"./dist/esm/BackendCommands.d.ts\",\n          \"default\": \"./dist/esm/BackendCommands.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/BackendCommands.d.ts\",\n          \"default\": \"./dist/cjs/BackendCommands.js\"\n        }\n      },\n      \"./IssueTodoDraft\": {\n        \"import\": {\n          \"types\": \"./dist/esm/IssueTodoDraft.d.ts\",\n          \"default\": \"./dist/esm/IssueTodoDraft.js\"\n        },\n        \"require\": {\n          \"types\": \"./dist/cjs/IssueTodoDraft.d.ts\",\n          \"default\": \"./dist/cjs/IssueTodoDraft.js\"\n        }\n      }\n    }\n  },\n  \"scripts\": {\n    \"lint\": \"eslint src --max-warnings=0 && dprint check\",\n    \"format\": \"dprint fmt\",\n    \"build\": \"node scripts/build.mjs\",\n    \"check\": \"tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit\",\n    \"circular\": \"node scripts/circular.mjs\",\n    \"test\": \"vitest\",\n    \"bench\": \"vitest bench --run --coverage.enabled=false --reporter=verbose\",\n    \"coverage\": \"vitest --coverage\"\n  },\n  \"dependencies\": {\n    \"@anthropic-ai/claude-agent-sdk\": \"0.3.283\",\n    \"@clack/prompts\": \"1.7.0\",\n    \"@opentui/core\": \"0.5.11\",\n    \"@opentui/react\": \"0.5.11\",\n    \"@smthrs/agent\": \"1.0.0-rc.14\",\n    \"@smthrs/build-cli\": \"1.0.0-rc.14\",\n    \"@smthrs/canonical\": \"1.0.0-rc.14\",\n    \"@smthrs/capability\": \"1.0.0-rc.14\",\n    \"@smthrs/control\": \"1.0.0-rc.14\",\n    \"@smthrs/crypto\": \"1.0.0-rc.14\",\n    \"@smthrs/database\": \"1.0.0-rc.14\",\n    \"@smthrs/engine\": \"1.0.0-rc.14\",\n    \"@smthrs/engine-store\": \"1.0.0-rc.14\",\n    \"@smthrs/evals\": \"1.0.0-rc.14\",\n    \"@smthrs/flow\": \"1.0.0-rc.14\",\n    \"@smthrs/flows\": \"1.0.0-rc.14\",\n    \"@smthrs/gateway\": \"1.0.0-rc.14\",\n    \"@smthrs/harness\": \"1.0.0-rc.14\",\n    \"@smthrs/integrations\": \"1.0.0-rc.14\",\n    \"@smthrs/jj\": \"1.0.0-rc.14\",\n    \"@smthrs/journal\": \"1.0.0-rc.14\",\n    \"@smthrs/kernel\": \"1.0.0-rc.14\",\n    \"@smthrs/mcp\": \"1.0.0-rc.14\",\n    \"@smthrs/memory\": \"1.0.0-rc.14\",\n    \"@smthrs/migrate\": \"1.0.0-rc.14\",\n    \"@smthrs/model\": \"1.0.0-rc.14\",\n    \"@smthrs/notifications\": \"1.0.0-rc.14\",\n    \"@smthrs/observability\": \"1.0.0-rc.14\",\n    \"@smthrs/plan\": \"1.0.0-rc.14\",\n    \"@smthrs/platform-node\": \"1.0.0-rc.14\",\n    \"@smthrs/registry\": \"1.0.0-rc.14\",\n    \"@smthrs/run-store\": \"1.0.0-rc.14\",\n    \"@smthrs/scorers\": \"1.0.0-rc.14\",\n    \"@smthrs/std\": \"1.0.0-rc.14\",\n    \"@smthrs/step-cache\": \"1.0.0-rc.14\",\n    \"@smthrs/sync\": \"1.0.0-rc.14\",\n    \"@smthrs/targets\": \"1.0.0-rc.14\",\n    \"@smthrs/time-travel\": \"1.0.0-rc.14\",\n    \"@smthrs/triggers\": \"1.0.0-rc.14\",\n    \"diff\": \"9.0.0\",\n    \"incur\": \"0.5.1\",\n    \"react\": \"19.2.8\",\n    \"smol-toml\": \"1.8.0\",\n    \"tar\": \"7.5.22\",\n    \"typescript\": \"5.9.3\",\n    \"yaml\": \"2.9.0\",\n    \"@smthrs/sandbox\": \"1.0.0-rc.14\",\n    \"undici\": \"8.11.2\",\n    \"redis\": \"6.2.1\",\n    \"@types/ws\": \"8.18.2\",\n    \"ws\": \"8.22.0\",\n    \"@effect/sql-sqlite-node\": \"4.0.5\"\n  },\n  \"devDependencies\": {\n    \"@effect/language-service\": \"0.87.2\",\n    \"@effect/sql-sqlite-node\": \"4.0.5\",\n    \"@effect/vitest\": \"4.0.5\",\n    \"@eslint/js\": \"9.39.5\",\n    \"@smthrs/artifacts\": \"1.0.0-rc.14\",\n    \"@smthrs/testing\": \"1.0.0-rc.14\",\n    \"@types/node\": \"26.4.1\",\n    \"@vitest/coverage-v8\": \"5.0.0\",\n    \"dprint\": \"0.57.1\",\n    \"esbuild\": \"0.28.2\",\n    \"eslint\": \"9.39.5\",\n    \"eslint-import-resolver-typescript\": \"4.4.5\",\n    \"eslint-plugin-import\": \"2.32.0\",\n    \"eslint-plugin-jsdoc\": \"64.3.4\",\n    \"eslint-plugin-unicorn\": \"65.0.0\",\n    \"madge\": \"8.0.0\",\n    \"typescript-eslint\": \"8.69.0\",\n    \"vitest\": \"5.0.0\",\n    \"@effect/platform-node\": \"4.0.5\",\n    \"@effect/platform-node-shared\": \"4.0.5\",\n    \"effect\": \"4.0.5\",\n    \"fast-check\": \"4.9.0\",\n    \"@effect/sql-pg\": \"4.0.5\",\n    \"@effect/platform-bun\": \"4.0.5\"\n  },\n  \"peerDependencies\": {\n    \"effect\": \"4.0.5\",\n    \"@effect/sql-pg\": \"4.0.5\",\n    \"@effect/sql-sqlite-node\": \"4.0.5\"\n  },\n  \"peerDependenciesMeta\": {\n    \"@effect/sql-pg\": {\n      \"optional\": true\n    }\n  }\n}\n",
    "lang": "json"
  },
  "packages/rpc/package.json": {
    "content": "{\n  \"name\": \"@smthrs/rpc\",\n  \"version\": \"0.0.0\",\n  \"private\": true,\n  \"smthrs\": {\n    \"group\": \"tooling\"\n  },\n  \"type\": \"module\",\n  \"description\": \"Contract modules shared by the Smithers native app (apps/app) and the Cloudflare Worker (apps/server): zod schemas, route constants, and RPC types, plus BrowserFetch, the shared browser-tool fetch handler both hosts run\",\n  \"exports\": {\n    \"./package.json\": \"./package.json\",\n    \"./*\": {\n      \"types\": \"./src/*.ts\",\n      \"default\": \"./src/*.ts\"\n    },\n    \"./fixtures/*\": {\n      \"types\": \"./test/fixtures/*.ts\",\n      \"default\": \"./test/fixtures/*.ts\"\n    },\n    \"./testing/LiveDocRelay\": {\n      \"types\": \"./src/testing/LiveDocRelay.ts\",\n      \"default\": \"./src/testing/LiveDocRelay.ts\"\n    }\n  },\n  \"scripts\": {\n    \"check\": \"tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit\",\n    \"typecheck\": \"tsc --noEmit\",\n    \"test\": \"vitest run\",\n    \"lint\": \"eslint src --max-warnings=0 && dprint check\"\n  },\n  \"dependencies\": {\n    \"@smthrs/canonical\": \"1.0.0-rc.14\",\n    \"string-width\": \"7.2.0\",\n    \"zod\": \"4.5.4\",\n    \"yjs\": \"13.6.32\"\n  },\n  \"devDependencies\": {\n    \"@types/node\": \"26.4.1\",\n    \"dprint\": \"0.55.2\",\n    \"eslint\": \"9.39.1\",\n    \"typescript\": \"^5.9.3\",\n    \"typescript-eslint\": \"8.65.0\",\n    \"vitest\": \"5.0.0\"\n  }\n}\n",
    "lang": "json"
  },
  "packages/smithers/docs/guides/change-code.md": {
    "content": "# Change your code with a flow\n\nRun a coding agent on your subscription, inspect its changes, then commit and push them yourself. Smithers does not review or land this change. You review the diff and tests and push with your own tools. A [person-only local landing route](https://github.com/smithersai/smithers/issues/4261) is planned.\n\n## Install\n\nUse Node 26.4.0 or later and install jj as described in [Installation](../installation.md).\n\n```bash\nnpm install -g smthrs@next\nsmthrs --version\n```\n\nThe tested prerelease printed `1.0.0-rc.12`. That prerelease needs the generated-flow fixes tracked in [#4231](https://github.com/smithersai/smithers/issues/4231); use a newer prerelease containing those fixes before continuing.\n\n## Create a project\n\n```bash\nmkdir slug\ncd slug\nprintf '{\"name\":\"slug\",\"type\":\"module\",\"scripts\":{\"test\":\"node --test\"}}\\n' > package.json\nprintf 'export const name = \"slug\"\\n' > index.js\njj git init .\njj config set --repo user.name 'Docs Test User'\njj config set --repo user.email docs@example.invalid\njj describe -m 'Initial tiny project'\njj new\n```\n\nUse your own name and email. For an existing project, start in its directory instead. If you use Git, replace the jj commands above with:\n\n```bash\ngit init -b main\ngit config user.name 'Docs Test User'\ngit config user.email docs@example.invalid\ngit add .\ngit commit -m 'Initial tiny project'\n```\n\nSmithers uses jj to show changes, including in Git projects. In a Git project, also run `jj git init --colocate .` before continuing.\n\n## Choose your subscription\n\n```bash\nsmthrs generate flow coding\n```\n\nOpen `.smithers/flows/coding/flow.ts`. Set both `seat` and `model` to `\"openai:gpt-6.1-sol\"` for Codex, or `\"opus\"` for Claude. Keep credentials out of the file.\n\nFor an existing Codex login:\n\n```bash\nexport SMITHERS_OPENAI_AUTH=chatgpt\nunset ANTHROPIC_API_KEY OPENAI_API_KEY AI_GATEWAY_API_KEY\n```\n\nIf you have not connected a subscription, follow [Installation](../installation.md#requirements) first. The Codex path below was tested on a Pro subscription. The Claude alternative was not tested in this walkthrough.\n\n## Ask for the change\n\n```bash\nsmthrs flow start coding --data '{\"args\":\"Add an exported slugify(text) function to index.js with tests in index.test.js using node:test and node:assert/strict. Lowercase text, replace spaces with hyphens, remove punctuation, trim hyphens. Actually write code and tests, run node --test. Do not commit, approve, merge, land or move main.\"}'\n```\n\nTrimmed output from the subscription run:\n\n```text\n_tag: Accepted\nreceiptId: \"approve:plan-2\"\nrunId: run-2\n```\n\nUse the run id printed by your command:\n\n```bash\nsmthrs runs show run-2\n```\n\nTrimmed output:\n\n```text\nrunId: run-2\nflowId: coding\nstatus: completed\n```\n\nContinue only after `status: completed`. If it failed or parked, inspect the diagnosis in `runs show` and follow [Diagnose a run](./diagnose-a-run.md).\n\n## Review and test\n\n```bash\nsmthrs change diff\nnode --test\n```\n\nThe recorded diff included `Modified regular file index.js` and `Added regular file index.test.js`. The test output ended with:\n\n```text\n\u2139 tests 6\n\u2139 pass 6\n\u2139 fail 0\n```\n\nRead the whole diff, including generated flow files. Check that the tests cover the behavior you requested. Your agent may produce different code and a different test count.\n\n## Commit and push yourself\n\nConfigure `origin` for your repository if it is not already set. With jj:\n\n```bash\njj git remote add origin /path/to/your/origin.git\njj describe -m 'Add slugify'\njj bookmark set main -r @\njj new\njj git push --remote origin --bookmark main --allow-new\n```\n\nWith Git, use these commands instead:\n\n```bash\ngit remote add origin /path/to/your/origin.git\ngit add .\ngit commit -m 'Add slugify'\ngit push -u origin main\n```\n\nReplace the example remote path with your own remote. Skip `remote add` when `origin` already exists. Follow your repository's branch and pull request policy when it requires review before main.\n",
    "lang": "md"
  },
  "docs/architecture/0001-shared-product.md": {
    "content": "# ADR 0001: One Smithers product, several assemblies\n\nStatus: accepted for the pre-release cutover (2026-09-21). Superseded for the Mac install by [ADR 0002](0002-mac-install.md). Implements the ownership decision in [issue 1655](https://github.com/smithersai/smithers/issues/1655). The source inventory below describes the starting point; it is not a claim that extraction is complete.\n\n## Decision\n\nSmithers owns one Go product backend, one web application, one product HTTP contract, and the existing TypeScript Flow engine. The root Go module is `github.com/smithersai/smithers`. Go libraries live under `packages/*`; application entrypoints live under `apps/*`, just like TypeScript packages and apps. `packages/backend/app` is the small public composition API and `packages/backend/internal` owns handlers, product services, persistence, and background jobs. `apps/backend` is the ordinary executable. `packages/backend/ports` contains only deployment-dependent repository, blob, and execution/access contracts demonstrated by the implementations. Plue may import public Smithers packages and supply adapters and configuration; Smithers must never import Plue.\n\n**Superseded for the Mac install by [ADR 0002](0002-mac-install.md).** The supported self-hosted web topology is **one ordinary Smithers app container plus PostgreSQL** for one owner. The app serves the web assets and API, uses a persistent `/var/lib/smithers` volume for repository and blob bytes, and bundles the trusted TypeScript Flow host. The local executor runs bounded child processes for code trusted by that owner. Its advertised isolation level is `trusted_process`. It is not an untrusted-code boundary. The hosted Plue assembly uses the same product services, schema, routes, and Flow artifacts, with cluster storage and an isolated sandbox executor. An untrusted-code guarantee is advertised only when that executor actually provides it. The self-hosted bootstrap has one owner, no public signup or organization onboarding, and no claim of multitenant isolation; Plue retains the shared authorization core for secure multitenant deployment.\n\n**Superseded for the Mac install by [ADR 0002](0002-mac-install.md).** The native app can start its own local Smithers backend and PostgreSQL, or point at a remote Plue or self-hosted Smithers backend. Its local database is a bundled real PostgreSQL instance in Application Support, with a singleton process, persisted credential, local-only listener, readiness before migrations, and safe restart. Remote native mode starts neither local service. The web app similarly points at Plue or a self-hosted Smithers origin. The frontend's modes are configuration of the same backend contract; modes do not get independent business rules or flow graphs.\n\nPostgreSQL owns all server-side product records, admitted jobs, receipts, and event cursors in every edition. There is one schema and migration sequence. Runtime-local SQLite may store one executor's Flow journal; device-local storage may hold drafts and presentation state. Neither substitutes for product PostgreSQL. This costs one database service in a self-hosted deployment, but prevents a second product transaction, migration, queue, and recovery implementation.\n\n`@smthrs/flow` remains the sole Flow model. Go admits and observes work and the packaged TypeScript host executes it through the explicit protocol in [issue 1662](https://github.com/smithersai/smithers/issues/1662). No Go graph, alternate node model, or backend-specific Flow interpreter is permitted.\n\nThe product is pre-release, so this is a deliberate breaking cutover. Existing Cloudflare identity, chat, billing, API forwarding, URLs, and Plue product handlers are extraction sources, not permanent compatibility requirements. Preserve product data and necessary security invariants; retire duplicate authorities after parity is proven.\n\n## Ownership and import rules\n\n| Concern | Smithers owns | Plue owns |\n| --- | --- | --- |\n| Product HTTP API, auth, permissions, repositories, jobs, chat, billing, integrations, notifications, UI and CLI | Services, handlers, schema, DTOs, generated clients, tests | Configures and imports the public app API; no copied handlers or product policy |\n| Repository and blob bytes | Product semantics, local storage, integrity and recovery | Cluster placement, volumes/object-store adapter, movement and infrastructure backup |\n| Execution | Job admission, durable receipts, Flow runtime, trusted local executor, capability contract | Isolated executor, fleet capacity and placement, node operations |\n| Deployment | One-container release, asset bundle, migrations, local lifecycle | Kubernetes entrypoints, ingress, IAM, observability wiring and infrastructure state |\n\nOnly `packages/backend/app` and `packages/backend/ports` are supported Go imports for deployment consumers. `packages/backend/internal` is hidden by Go's `internal` rule. Plue must depend on a pinned Smithers version without a sibling checkout `replace` or source copy. The default `apps/backend` import graph must not include Kubernetes or GCP deployment SDKs. Cluster adapters belong in Plue. A dependency check enforces the Smithers side; the Plue side is also checked in the cross-repository parity gate.\n\nKeep deployment seams narrow. Repository storage/execution is a product operation with a local store or cluster routing adapter. Blob operations use immutable keys, streams, integrity metadata, and idempotent deletion; signed cloud URLs are an optional adapter behavior, not the product contract. An executor reports its actual isolation, supports bounded execution and cancellation, and grants access to running workspaces without leaking provider SDK objects into product code. PostgreSQL connections and job admission are common implementation, not interchangeable deployment ports. Do not abstract every table, route, or graph node.\n\n## Data authority\n\n| Data | Authority | Recovery rule |\n| --- | --- | --- |\n| Users, sessions, permissions, product records, conversations, admitted commands, jobs, receipts, event cursors | Smithers PostgreSQL | Migrate and back up one product schema; replay durable server facts |\n| Flow state, approvals, execution journal | Canonical TypeScript Control runtime | Restore the executor-owned journal and reconcile its terminal receipt with Go |\n| Revisions, worktrees, immutable blobs | Repository/blob store | Reconcile recorded intent and expected revisions with PostgreSQL; no pretend cross-store transaction |\n| Drafts, pending local intent, presentation projections | Device-local client journal | Recover server facts from API; export local-only drafts separately |\n| Placement, fleet leases, infrastructure operations | Plue infrastructure | May reference product IDs; cannot redefine permissions or completion |\n\nA command can return `requested` immediately after its client-side intent is persisted. The API says `accepted` only after durable PostgreSQL admission; execution completion needs a terminal receipt. Duplicate input is idempotent, in-flight work is recoverable after reload, and a transport acknowledgment is never success. The [app interaction rules](../../AGENTS.md) apply in every mode.\n\n## Product extraction inventory\n\n| Area and starting source | Smithers destination | Owning issue |\n| --- | --- | --- |\n| Plue `internal/services`, `internal/routes`, `db/schema.sql`, `cmd/server` | `packages/backend/internal`, product schema, public app composition | [1657](https://github.com/smithersai/smithers/issues/1657) |\n| Plue `internal/repohost`, Git/SSH, `smithers-ffi`, repository jobs | Shared repo engine and local/cluster storage port | [1658](https://github.com/smithersai/smithers/issues/1658) |\n| Plue blob/GCS paths and snapshots | Filesystem blob adapter, immutable storage contract | [1659](https://github.com/smithersai/smithers/issues/1659) |\n| Plue auth, sessions, permissions, API tokens, SSH credentials; `smithersai/ui/workers/identity` | Common identity and credential services | [1660](https://github.com/smithersai/smithers/issues/1660) |\n| Plue durable jobs/outbox and Smithers client notification state | Admission, receipts, authorized event replay | [1661](https://github.com/smithersai/smithers/issues/1661) |\n| `packages/smithers/flows`, Control and workspace host | One Flow authority, Go-to-host protocol | [1662](https://github.com/smithersai/smithers/issues/1662) |\n| `smithersai/ui/workers/chat`, Plue conversation APIs, app turn host, push | Common chat/model routing, durable turns and push dispatch | [1663](https://github.com/smithersai/smithers/issues/1663) |\n| `smithersai/ui/workers/billing`, Plue billing/integrations, GitHub/Notion sync, email/push notifications | Optional common provider modules | [1664](https://github.com/smithersai/smithers/issues/1664) |\n| Plue microsandbox worker and local harness; workspace terminal/access | Bounded trusted-process executor, explicit isolation capability | [1665](https://github.com/smithersai/smithers/issues/1665) |\n| `apps/app`, `apps/server` Worker gateway, Bun local server, `packages/rpc`, Plue CLI | One web/native API, generated clients, common product CLI | [1666](https://github.com/smithersai/smithers/issues/1666) |\n| Static assets, Bun host, native helpers, Go binary, migrations, `/data` lifecycle | One-container release and native bundle | [1667](https://github.com/smithersai/smithers/issues/1667) |\n| Plue Kubernetes composition and deployment | Public Smithers API composition, cluster adapters | [plue 508\u2013510](https://github.com/smithersai/plue/issues/508) |\n| Mode parity, clean-room install, Plue cutover | Matrix gate then removal of duplicate product authorities | [1668](https://github.com/smithersai/smithers/issues/1668), [plue 511](https://github.com/smithersai/plue/issues/511) |\n\nThe CLI, SSH, runtime assets, chat, push, billing, and identity are all product surfaces. None can remain a required external Smithers-controlled service for self-hosting. GitHub, model providers, payment providers, email and push transports remain optional configured integrations; missing credentials must disable that feature honestly rather than route silently to Smithers infrastructure.\n\n## External seams and licenses\n\nThe current web gateway declares identity, billing, chat and Plue API upstreams in `apps/server/wrangler.jsonc` and documents their deployed identities in `apps/UPSTREAMS.md`. Identity, chat and billing source lives in the separate `smithersai/ui/workers` tree; that inventory also names connectors-catalog, cron, status, sync and webhooks. Audit and move any product behavior before calling self-hosting independent. The existing repo includes `THIRD_PARTY_NOTICES.md`, and Plue's checked-in source is MIT licensed. The `smithersai/ui` worker tree is not present in this workspace; its license and transitive notices must be verified from source before copying code or publishing a distribution. Preserve notices for vendored Effect and jj code and produce dependency notices for the bundled Go, Bun and native artifacts.\n\n## Mode gate\n\nOne test suite runs against a backend URL with the same contract assertions. Required rows: Docker self-hosted app + PostgreSQL, native app + local backend/PostgreSQL, native app + Plue, web app + Plue, and web app + self-hosted backend. The isolated execution tests are required only when the backend advertises `isolated`; trusted local process tests must prove bounded concurrency, cancellation and persistence without claiming isolation. The matrix covers auth, repository creation/import, chat, jobs and receipts, Flow approval/restart, artifacts, terminal and reload. `apps/backend` and Plue composition must run common Go service tests; the browser/native clients must run the same contract tests against both origins.\n",
    "lang": "md"
  },
  ".smithers/environment.nix": {
    "content": "# The Smithers Cloud machine for this repository.\n#\n# Owner decision (2026-09-15): Cloud machines are NixOS built from a\n# per-repository `.smithers/environment.nix`, and Cloud CI moves off the Debian\n# runner pool onto NixOS guests booted from this closure. This module is\n# imported after `nix/modules/base.nix` in the plue repository (see that repo's\n# `nix/README.md`); it adds to the base and never replaces it. Only the file\n# itself reaches the builder, so it carries no relative imports.\n#\n# Everything `.github/scripts/ci/cloud.sh` and `.github/workflows/ci.yml` install at run\n# time is pinned here instead, at the exact release the repository declares, so\n# a gate starts with its toolchain already on PATH and downloads nothing:\n#\n#   Node       .node-version / package.json engines.node\n#   npm        PACKAGE.ts `CiToolchain.Node({ npmRelease })`\n#   pnpm       package.json packageManager\n#   Bun        .smithers/WORKSPACE.ts bunVersion\n#   jj         .smithers/WORKSPACE.ts jjVersion\n#   Rust       rust-toolchain.toml (channel, components, targets)\n#   Go         PACKAGE.ts `CiToolchain.Go`\n#   PostgreSQL PACKAGE.ts `CiToolchain.Postgres` (major release)\n#   Foundry    PACKAGE.ts `CiToolchain.Foundry` / cloud.sh ensure_foundry\n#   ripgrep    PACKAGE.ts `CiToolchain.Ripgrep` (the base pin already matches)\n#\n# `.github/scripts/ci/environment-nix.test.ts` reads those files and this one and fails\n# on drift, so a version moves in one place.\n#\n# The base module already ships bash, coreutils, curl, git, jq, python3,\n# ripgrep 14.1.1, rsync, procps and the language servers. Node, npm, Bun and jj\n# are in the base too, at the versions the platform picked rather than the ones\n# this repository pins, so each of those four is `lib.hiPrio` here: NixOS builds\n# the system profile with `buildEnv { ignoreCollisions = true; }`, which settles\n# a colliding `bin/` entry by `meta.priority` before order, and the base module\n# is imported first.\n{ pkgs, lib, ... }:\nlet\n  inherit (pkgs) fetchurl;\n\n  # Every guest is x86_64-linux (plue's nix/toplevel.nix evaluates only that\n  # system), so each pin below is one release artifact and one digest.\n\n  # Node for every gate: the whole pipeline is `pnpm exec smthrs \u2026`.\n  # Checksum: the linux-x64 .tar.xz line of\n  # https://nodejs.org/dist/v26.5.0/SHASUMS256.txt.\n  nodejs = pkgs.stdenv.mkDerivation rec {\n    pname = \"nodejs\";\n    version = \"26.5.0\";\n    src = fetchurl {\n      url = \"https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz\";\n      sha256 = \"9f619528f1db5ddc41dccf54211066fb42228d69a156733c69cb9d6cc92e358c\";\n    };\n    nativeBuildInputs = [ pkgs.autoPatchelfHook ];\n    buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];\n    dontConfigure = true;\n    dontBuild = true;\n    installPhase = ''\n      runHook preInstall\n      mkdir -p $out\n      cp -a . $out\n      runHook postInstall\n    '';\n    meta.platforms = [ \"x86_64-linux\" ];\n  };\n\n  # The certified npm both CI files install (`npm@11.16.0`). Node 26.5.0 bundles\n  # 11.17.0, so this one has to win `bin/npm` against the Node package as well\n  # as against the base: a priority below `lib.hiPrio`'s -10 does that.\n  npm = pkgs.stdenvNoCC.mkDerivation rec {\n    pname = \"npm\";\n    version = \"11.16.0\";\n    src = fetchurl {\n      url = \"https://registry.npmjs.org/npm/-/npm-${version}.tgz\";\n      sha256 = \"30fc15697c771002878665c29f49dddde9aa8667fa5719854b2f52d3cd19230b\";\n    };\n    dontBuild = true;\n    installPhase = ''\n      runHook preInstall\n      mkdir -p $out/lib/node_modules/npm $out/bin\n      cp -a . $out/lib/node_modules/npm\n      chmod +x $out/lib/node_modules/npm/bin/npm-cli.js $out/lib/node_modules/npm/bin/npx-cli.js\n      ln -s $out/lib/node_modules/npm/bin/npm-cli.js $out/bin/npm\n      ln -s $out/lib/node_modules/npm/bin/npx-cli.js $out/bin/npx\n      runHook postInstall\n    '';\n  };\n\n  # pnpm at exactly `packageManager`: every gate runs through `pnpm exec`, and\n  # the same tarball and digest are already pinned in flake.nix. A channel's\n  # moving pnpm would not satisfy a build tool that asserts an exact version.\n  pnpm = pkgs.stdenvNoCC.mkDerivation rec {\n    pname = \"pnpm\";\n    version = \"11.25.0\";\n    src = fetchurl {\n      url = \"https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz\";\n      hash = \"sha256-M90HSPJ+eRbE8ci2lDRhmD40U7BrvaYxKmKAEwtIgeU=\";\n    };\n    dontBuild = true;\n    installPhase = ''\n      runHook preInstall\n      mkdir -p $out/lib/pnpm $out/bin\n      cp -r . $out/lib/pnpm\n      chmod +x $out/lib/pnpm/bin/pnpm.cjs $out/lib/pnpm/bin/pnpx.cjs\n      ln -s $out/lib/pnpm/bin/pnpm.cjs $out/bin/pnpm\n      ln -s $out/lib/pnpm/bin/pnpx.cjs $out/bin/pnpx\n      runHook postInstall\n    '';\n  };\n\n  # Bun runs `//apps/app:unitTests`, the app's e2e web server, and the\n  # `cloud-contract` gate (`bun test .github/scripts/ci/cloud.test.ts`). The zip is the\n  # release oven-sh publishes, which is what nixpkgs repackages too.\n  bun = pkgs.stdenv.mkDerivation rec {\n    pname = \"bun\";\n    version = \"1.4.1\";\n    src = fetchurl {\n      url = \"https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64.zip\";\n      sha256 = \"74c1c3bee7cd998500c8f969cd8972355ac6a07207e94a39eece1999b56ffabf\";\n    };\n    nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];\n    buildInputs = [ pkgs.stdenv.cc.cc.lib ];\n    dontBuild = true;\n    installPhase = ''\n      runHook preInstall\n      install -Dm755 bun $out/bin/bun\n      ln -s $out/bin/bun $out/bin/bunx\n      runHook postInstall\n    '';\n    meta.platforms = [ \"x86_64-linux\" ];\n  };\n\n  # jj at the release the repository pins, for every gate whose toolchain list\n  # names `jj` (`workspace`, `packages`, `examples`, `scripts`, `server`,\n  # `faults`, the `ui-*` gates, `swebench`). The base module\n  # ships jujutsu from the platform's unstable pin, which is a different\n  # release; cloud.sh's `ensure_jj` re-downloads unless `jj --version` is\n  # exactly this, so the pin belongs here.\n  jujutsu = pkgs.stdenvNoCC.mkDerivation rec {\n    pname = \"jujutsu\";\n    version = \"0.39.0\";\n    src = fetchurl {\n      url = \"https://github.com/jj-vcs/jj/releases/download/v${version}/jj-v${version}-x86_64-unknown-linux-musl.tar.gz\";\n      sha256 = \"8da8d96e9c8696c21ad47847a63d533e249acb0449d9af0f0562b5ea7b024f04\";\n    };\n    # The tarball has no top-level directory: ./jj, ./README.md, ./LICENSE.\n    sourceRoot = \".\";\n    dontBuild = true;\n    installPhase = ''\n      runHook preInstall\n      install -Dm755 jj $out/bin/jj\n      runHook postInstall\n    '';\n    meta.platforms = [ \"x86_64-linux\" ];\n  };\n\n  # The `rust-lint`, `rust-test`, `third-party-notices` and `scripts` gates, and\n  # the wasm artifact the `wasm-repro` job rebuilds byte for byte.\n  #\n  # rust-toolchain.toml pins channel 1.98.0, profile minimal, components clippy\n  # and rustfmt, target wasm32-wasip1 \u2014 assembled here from the same standalone\n  # installers rustup would fetch, so no rustup and no run-time channel\n  # download. `rust-src` stays out on purpose: rust-toolchain.toml explains that\n  # installing it moves std spans off their `/rustc/<hash>` form and changes the\n  # committed wasm bytes. rust-docs is dropped for size; nothing reads it.\n  #\n  # Digests: the `xz_hash` entries of\n  # https://static.rust-lang.org/dist/channel-rust-1.98.0.toml.\n  rust =\n    let\n      version = \"1.98.0\";\n      date = \"2026-08-20\";\n      dist = name: sha256: fetchurl {\n        url = \"https://static.rust-lang.org/dist/${date}/${name}\";\n        inherit sha256;\n      };\n    in\n    pkgs.stdenv.mkDerivation {\n      pname = \"rust\";\n      inherit version;\n      srcs = [\n        (dist \"rust-${version}-x86_64-unknown-linux-gnu.tar.xz\"\n          \"ed8ee2df70909c88cbaf87a6cfa3920dac00b537de12a6abe6906641e0f5952f\")\n        (dist \"clippy-${version}-x86_64-unknown-linux-gnu.tar.xz\"\n          \"646c6bd2450ea4c32a3c78ad7a3727294eea1f1519718a3f1487424021695ffa\")\n        (dist \"rustfmt-${version}-x86_64-unknown-linux-gnu.tar.xz\"\n          \"8922a03e68265a74a8040590e28b173fb5d9d49655bb6eacfd880fbd3bef0dc3\")\n        (dist \"rust-std-${version}-wasm32-wasip1.tar.xz\"\n          \"07af7da4d9e943226c438cd5b60ba2b1f23a88c077eb09ccb227a385529c8b08\")\n      ];\n      sourceRoot = \".\";\n      nativeBuildInputs = [ pkgs.autoPatchelfHook ];\n      buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];\n      dontBuild = true;\n      # Stripping an rlib removes its .rmeta section (see nixpkgs' rust\n      # binary.nix), which breaks every crate that links it.\n      dontStrip = true;\n      # A standalone installer is a directory per component plus a `components`\n      # file naming them; copying the components is install.sh without its\n      # manifest bookkeeping, which is what lets four of them share one prefix.\n      installPhase = ''\n        runHook preInstall\n        mkdir -p $out\n        for pkgdir in */; do\n          [ -f \"$pkgdir/components\" ] || continue\n          while read -r component; do\n            case \"$component\" in rust-docs*) continue ;; esac\n            [ -d \"$pkgdir$component\" ] || continue\n            cp -a \"$pkgdir$component/.\" \"$out/\"\n            chmod -R u+w \"$out\"\n          done < \"$pkgdir/components\"\n        done\n        rm -f $out/manifest.in\n        runHook postInstall\n      '';\n      meta.platforms = [ \"x86_64-linux\" ];\n    };\n\n  # `//packages/smithers/build/build-cli:test` builds a real Go package tree\n  # (PACKAGE.ts says so, and ci.yml installs Go for the jobs that run it). The\n  # pinned nixpkgs only carries Go 1.23, so take the release tarball.\n  # Checksum: https://go.dev/dl/?mode=json&include=all.\n  go = pkgs.stdenvNoCC.mkDerivation rec {\n    pname = \"go\";\n    version = \"1.26.8\";\n    src = fetchurl {\n      url = \"https://go.dev/dl/go${version}.linux-amd64.tar.gz\";\n      sha256 = \"d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b\";\n    };\n    dontBuild = true;\n    dontStrip = true;\n    installPhase = ''\n      runHook preInstall\n      mkdir -p $out/share/go $out/bin\n      cp -a . $out/share/go\n      ln -s $out/share/go/bin/{go,gofmt} $out/bin/\n      runHook postInstall\n    '';\n    meta.platforms = [ \"x86_64-linux\" ];\n  };\n\n  # The same `//packages/smithers/build/build-cli:test` cases build and test a\n  # Foundry package and assert `forge fmt --check` drift; cloud.sh's\n  # `ensure_foundry` names this exact release. No published checksum file, so\n  # the digest is of the release asset itself.\n  foundry = pkgs.stdenv.mkDerivation rec {\n    pname = \"foundry\";\n    version = \"1.8.1\";\n    src = fetchurl {\n      url = \"https://github.com/foundry-rs/foundry/releases/download/v${version}/foundry_v${version}_linux_amd64.tar.gz\";\n      sha256 = \"37b45855232e57624d90113b049ca54f0c92055bb5c1997fcbdc3076c7b89c10\";\n    };\n    sourceRoot = \".\";\n    nativeBuildInputs = [ pkgs.autoPatchelfHook ];\n    buildInputs = [ pkgs.stdenv.cc.cc.lib ];\n    dontBuild = true;\n    installPhase = ''\n      runHook preInstall\n      for tool in forge cast anvil chisel solar; do\n        install -Dm755 \"$tool\" \"$out/bin/$tool\"\n      done\n      runHook postInstall\n    '';\n    meta.platforms = [ \"x86_64-linux\" ];\n  };\n\n  # What a Playwright-downloaded Chromium dynamically links. The browsers ship\n  # as prebuilt binaries that open /lib64/ld-linux-x86-64.so.2, which nix-ld\n  # answers with these libraries, so `ui-browser` needs no root and no\n  # `playwright install --with-deps`.\n  playwrightLibraries = with pkgs; [\n    alsa-lib at-spi2-atk at-spi2-core atk cairo cups dbus expat\n    fontconfig freetype gdk-pixbuf glib gtk3 libdrm libglvnd mesa\n    libxkbcommon nspr nss pango udev\n    xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext xorg.libXfixes\n    xorg.libXrandr xorg.libxcb xorg.libxshmfence\n  ];\nin\n{\n  environment.systemPackages =\n    # The four the base also ships: priority, not order, decides the profile.\n    (map lib.hiPrio [ nodejs bun jujutsu ])\n    ++ [\n      # Below hiPrio's -10, so it also outranks the npm inside the Node tarball.\n      (lib.setPrio (-20) npm)\n      pnpm\n      rust\n      go\n      # Storage matrix tests run initdb and pg_ctl in a task-local cluster;\n      # the shared Go backend suite (`//:backendGo`) takes the same programs\n      # from PATH for its backup, restore and upgrade-recovery tests.\n      pkgs.postgresql_18\n      foundry\n      # `faults` and every confined target run under bubblewrap, which ci.yml\n      # apt-installs and cloud.sh cannot install at all on an unprivileged\n      # runner.\n      pkgs.bubblewrap\n      pkgs.openssh\n      # The `packages` gate's real SSH tests start an isolated `sshd`\n      # (`ensure_sshd` in cloud.sh, ExecutionEnvironmentSsh.integration.test.ts);\n      # apt's openssh-server cannot exist on NixOS.\n      # Linking for cargo: jj-lib arrives as a git dependency and builds its\n      # native halves from source.\n      pkgs.gcc\n      # `cc` is rustc's default linker and the `cc` crate's compiler; `ar` is\n      # what that crate archives its objects with.\n      pkgs.binutils\n      pkgs.pkg-config\n      pkgs.cmake\n      pkgs.perl\n      pkgs.openssl\n      pkgs.openssl.dev\n      # A system Chromium for anything that honours CHROME_PATH, beside the\n      # libraries above that let Playwright run its own pinned build.\n      pkgs.chromium\n      pkgs.ffmpeg-headless\n    ];\n\n  # Prebuilt glibc executables from npm (dprint's `@dprint/linux-x64-glibc`,\n  # Playwright's Chromium) name /lib64/ld-linux-x86-64.so.2 as their ELF\n  # interpreter. nix-ld serves that path once boot has run systemd-tmpfiles, so\n  # a check runs only in a guest booted with init, after activation; before it,\n  # every such exec fails with ENOENT (#3007, #4093). The base enables nix-ld\n  # too; this machine declares the loader it depends on.\n  programs.nix-ld.enable = true;\n  programs.nix-ld.libraries = playwrightLibraries;\n\n  # `Docker.Service` targets (the PostgreSQL databases behind the backend,\n  # history and cache suites) run `docker` against a local daemon whose image\n  # store is containerd's, which is what PACKAGE.ts `CiToolchain.Docker` asks\n  # for. Images are pulled by digest through the sandbox's egress proxy. The\n  # workspace user (`developer` in plue's base module) reaches the socket\n  # through the `docker` group.\n  virtualisation.docker = {\n    enable = true;\n    daemon.settings.features.containerd-snapshotter = true;\n  };\n  users.users.developer.extraGroups = [ \"docker\" ];\n\n  # Those SSH tests and cloud.sh name the Debian path `/usr/sbin/sshd` and need\n  # the privilege-separation directory `/run/sshd`, neither of which NixOS has.\n  systemd.tmpfiles.rules = [\n    \"d /run/sshd 0755 root root -\"\n    \"L+ /usr/sbin/sshd - - - - ${pkgs.openssh}/bin/sshd\"\n  ];\n\n  environment.variables = {\n    # Go: no toolchain switch (the guest has no egress to fetch one) and no VCS\n    # stamping (the build-cli fixture trees are not repositories).\n    GOTOOLCHAIN = \"local\";\n    GOFLAGS = \"-buildvcs=false\";\n    # Playwright validates host packages through the distribution package\n    # manager, which NixOS does not have; the libraries it is checking for are\n    # in nix-ld above.\n    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = \"1\";\n    CHROME_PATH = \"${pkgs.chromium}/bin/chromium\";\n    PKG_CONFIG_PATH = \"${pkgs.openssl.dev}/lib/pkgconfig\";\n  };\n}\n",
    "lang": "txt"
  }
})
REPOS["effeck/effeck"].files["docs/user/src/001-onboarding.md"] = {"content": "# Welcome to VibeLang\n\nVibeLang is a language for building reliable TypeScript in the AI era, built on [Effect](https://effect.website). It gives Effect a simple, readable syntax that compiles to TypeScript, so your team can ship production-ready systems with first-class access to the TypeScript ecosystem.\n\n```ts effect\nclass UserNotFound extends Schema.TaggedError<UserNotFound>()(\"UserNotFound\", {\n  id: Schema.String\n}) {}\n\nclass Users extends Context.Service<Users, {\n  find(id: string): Effect.Effect<User, UserNotFound>\n}>()(\"app/Users\") {}\n\nconst greet = Effect.fn(\"greet\")(function* (id: string) {\n  const users = yield* Users\n  const user = yield* users.find(id).pipe(\n    Effect.catchTag(\"UserNotFound\", () => Effect.succeed({ name: \"guest\" }))\n  )\n  return `Hello, ${user.name}`\n})\n```\n\n```ts\ninterface User { id: string; name: string }\n\nerror UserNotFound { id: string }\n\nservice Users {\n  find(id: string): User!UserNotFound\n}\n\nfunction greet(id: string) {\n  const name = Users.find(id).name catch \"guest\"\n  return `Hello, ${name}`\n}\n// string!!Users\n```\n\nA user service, a typed error, and a fallback, in Effect and in VibeLang. The comment under `greet` is the type your editor shows: `string!!Users` is VibeLang's spelling of `Effect<string, never, Users>`. It returns a `string`, cannot fail, and needs the `Users` service. The compiler infers all three from the body, and TypeScript code that imports `greet` sees the Effect type. The VibeLang version is about half the size: 71 tokens against 143.\n\nVibeLang is v0. The language will change in major, breaking ways, and it is not ready for production use.\n\n## Why a language\n\n**Effect makes TypeScript reliable.** A TypeScript signature says what a function returns, but not what can fail or what it depends on. Effect puts all three in one type, `Effect<Success, Error, Requirements>`, and the compiler checks it. Retries, timeouts, concurrency, resource cleanup, and tracing come with it.\n\n**Effect pays for it in syntax.** Effect is a library, so it builds every feature out of what TypeScript already has: generators and `yield*` to run steps in order, `pipe` to compose them, and classes to declare errors and services. The code reads like a separate language written in library calls.\n\n**VibeLang makes it a real language.** Each Effect idea gets its own syntax. Calls run in order, `throw` fails with a typed error, `catch` handles it, `service` declares a dependency, and `fork` starts a fiber. The compiler builds the same Effect program you would have written by hand.\n\n## TypeScript stays one step away\n\nA new language usually leaves its host's ecosystem behind. VibeLang keeps it in two ways:\n\n1. **It compiles to TypeScript.** VibeLang's compiler is TypeScript's compiler, extended. It checks `.vibe` and `.ts` files together and emits JavaScript and `.d.ts` files, so npm packages, your `.ts` files, and every Effect library work unchanged, and TypeScript code calls VibeLang functions as ordinary Effect functions.\n2. **You can opt out to plain TypeScript.** `sync`, `try`, and `callback` take a plain TypeScript function, and a `.ts` file can sit beside any `.vibe` file.\n\n```ts\nfunction slug(title: string) {\n  return sync((title) => {\n    // Plain TypeScript: nothing in here is an Effect.\n    let s = title.trim().toLowerCase()\n    s = s.replaceAll(/[^a-z0-9]+/g, \"-\")\n    return s\n  }, title)\n}\n// string!!\n```\n\nA hatch's function is self-contained: it reads the `.vibe` file's values only as the arguments passed after it, here `title`.\n\n## Effect's features, in VibeLang syntax\n\nEverything Effect does, VibeLang does, because the output is Effect. The common features have their own syntax:\n\n| Effect feature | VibeLang |\n| --- | --- |\n| Effect types | `User!NotFound!Users`: returns `User`, fails with `NotFound`, needs `Users` |\n| Typed errors | `error NotFound { id: string }`, `throw new NotFound({ id })`, `x catch fallback` |\n| Dependency injection | `service Users { ... }`, `provide UsersLive { ... }` |\n| Structured concurrency | `fork`, `join`, `await.all [a(), b()]`, `for concurrent(8) (const id of ids)` |\n| Retries and timeouts | `work() \\|> retry(%, policy) \\|> timeout(%, \"1 second\")` |\n| Resource safety | `using conn = connect()`, `finally` |\n| Tracing | `withSpan(\"checkout\") { ... }` |\n| Schema validation | `schema User { id: string; role: \"admin\" \\| \"member\" }` |\n| Pattern matching | `match (e) { when NotFound: ...; }` |\n\nStreams, configuration, and Effect's HTTP, SQL, CLI, and AI packages need no syntax of their own: call them as you would in TypeScript. The [cheat sheet](effeck-features/115-cheat-sheet.md) puts every VibeLang form beside the Effect code it replaces.\n\n## Built for the AI era\n\nWhen coding agents write a growing share of your code, the hard part moves from writing code to trusting it. Effect's answer is to make failures and dependencies visible to the compiler. VibeLang keeps that and makes the code worth reading:\n\n- **The compiler checks what agents write.** Every function's type lists what it can fail with and what it needs, and code that breaks a declared type does not compile, so an agent gets precise feedback to act on.\n- **People can review what agents write.** VibeLang code is about half the size of the Effect code it replaces, and it reads as plain TypeScript.\n- **Agents write less.** Fewer tokens per program means less to generate and less context to read back.\n\n## Try it\n\n```sh\nbun create vibelang my-app\ncd my-app\nbun run dev\n```\n\nThen open the folder in VS Code or Cursor and install the editor extension that comes with the compiler: `code --install-extension node_modules/vibelang/editor/vibelang.vsix`. [Installation](getting-started/004-installation.md) covers existing projects.\n\n## Where to go next\n\n- **Coming from Effect:** the [cheat sheet](effeck-features/115-cheat-sheet.md) shows every change, and [VibeLang for Effect users](effeck-features/114-effeck-for-effect-users.md) explains the rules.\n- **New to Effect:** start with [The Effect Type](getting-started/003-the-effect-type.md), then [Creating Effects](getting-started/005-creating-effects.md) and [Expected Errors](error-management/014-expected-errors.md).\n- **The full language:** the [specification](../../design/src/000-intro.md) defines every rule.\n", "lang": "md"}
for (const repo of Object.values(REPOS)) {
  for (const path of Object.keys(repo.files)) {
    const parts = path.split("/")
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/")
      const rows = repo.tree[dir] ??= []
      if (!rows.some(row => row.name === parts[i])) rows.push({ name: parts[i], kind: i === parts.length - 1 ? "file" : "dir", note: "", age: "Oct 17" })
    }
  }
  // Keep advertised fixture destinations readable.
  for (const rows of Object.values(repo.tree)) rows.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))
}
