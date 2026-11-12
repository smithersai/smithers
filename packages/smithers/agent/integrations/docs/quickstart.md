---
title: "Quickstart"
description: "From install to a first API call and a durable GitHub comment posted by a flow."
sidebar:
  order: 1
---

This tutorial takes you from an empty directory to two working results: an
authenticated call to the GitHub API through `GitHubClient`, and a comment on
an issue posted as a durable flow step, journaled so a restart replays the
recorded result instead of posting twice. Each step below is TypeScript; the
[VibeLang tab](#the-same-walkthrough-in-vibelang) runs steps 3 and 4 as Effect
code.

You need Node 22.19 or later and a GitHub token with issues write access to a
repository you own. A classic token with `repo` scope on a test repository
works.

## 1. Install

```bash
npm install @smthrs/integrations@next @smthrs/engine@next @smthrs/flow@next @effect/platform-node effect
```

## 2. Configure the credential

Export the token. `SMITHERS_GITHUB_TOKEN` is the variable the client reads
first; `GITHUB_TOKEN` is the fallback.

```bash
export SMITHERS_GITHUB_TOKEN=TOKEN
```

Replace `TOKEN` with your GitHub token.

## 3. Call the GitHub API

Build a client with `GitHub.GitHubClient.make` and ask for the authenticated
viewer. The client sends HTTP through Effect's `HttpClient`;
`FetchHttpClient.layer` provides the platform `fetch`.

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

const Viewer = Schema.Struct({ login: Schema.String })

const program = Effect.gen(function*() {
  const client = yield* GitHub.GitHubClient.make({})
  return yield* client.request("GET", "/user", undefined, { schema: Viewer })
})

const viewer = await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)))
console.log(viewer.login)
```

Run it (Node 22.19 runs TypeScript directly):

```bash
node viewer.ts
```

The program prints your GitHub login. Behind that one call the client pinned
the request URL to the configured API origin, put the token in the
`Authorization` header and nowhere else, and made exactly one request. A
failure rejects with an `IntegrationError` whose `reason` is machine-readable
and whose `details` say whether another attempt may help;
[troubleshooting](./troubleshooting.md) reads them.

## 4. Post a comment as a durable flow step

A client call is an Effect. An action is the same call made a step of a
durable flow: `CommentOnIssue.call(payload)` records a plan node, the engine
journals the result, and a restart replays the journal instead of posting a
second comment.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const CommentFlow = Flow.make("comment-flow", {
  payload: GitHub.Actions.CommentOnIssuePayload,
  success: GitHub.Actions.Comment,
  error: Core.ActionFailure.Failure,
  body: (input) => GitHub.Actions.CommentOnIssue.call(input)
})

const layer = Layer.mergeAll(GitHub.Actions.layer, Interpreter.layer(CommentFlow)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    Layer.mergeAll(
      FlowEngine.layerMemory,
      GitHub.GitHubClient.layer({}).pipe(Layer.provide(FetchHttpClient.layer)),
      NodeCrypto.layer
    )
  )
)

const program = CommentFlow.execute(
  { owner: "OWNER", repo: "REPO", issueNumber: 1, body: "Hello from Smithers." },
  { executionId: "run-comment-flow" }
).pipe(Effect.provide(layer), Effect.scoped)

const comment = await Effect.runPromise(program)
console.log(comment.url)
```

Replace `OWNER` and `REPO` with the owner and name of your test repository.

Three things in the wiring are load-bearing:

- `GitHub.Actions.layer` implements the action over the `GitHubClient` in
  context. A composition that calls the action but forgets the layer fails to
  compile, because the plan node demands the requirement the layer provides.
- `GitHub.GitHubClient.layer({})` builds the client from the environment you
  exported in step 2, over the `HttpClient` that `FetchHttpClient.layer`
  provides. Passing an `env` record as the second argument instead replaces
  the ambient environment outright.
- `FlowEngine.layerMemory` runs the flow without durability, which is what a
  first run wants. Production flows use a durable engine; see
  [the engine API](/api/engine).

Run it:

```bash
node comment.ts
```

The program prints the new comment's API URL, and the comment is visible on
the issue. The action is `tier: "irreversible"`: the engine never retries it
on its own, and the client never repeats a request. A write whose answer was
lost reports `outcomeUnknown` instead. [Durable actions](./concepts/durable-actions.md)
explains the contract.

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) the viewer read and the
comment are `effect` functions, and `Viewer` is a `schema` declaration. A
`.vibe` file reads no `process.env`, so both functions take the environment
the client reads its token from, and both leave the `HttpClient` to the
caller: provide `FetchHttpClient.layer` to reach GitHub, or a recording client
as the test does.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"

/** Where the client reads `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. */
type Environment = Readonly<Record<string, string | undefined>>

schema Viewer {
  readonly login: string
}

/** Asks GitHub whose token this is, over the `HttpClient` the caller provides. */
export effect function viewer(env: Environment) {
  const client = try GitHub.GitHubClient.make({}, env)
  return try client.request("GET", "/user", undefined, { schema: Viewer })
}

/** One comment, posted as a durable flow step. */
export const CommentFlow = Flow.make("comment-flow", {
  payload: GitHub.Actions.CommentOnIssuePayload,
  success: GitHub.Actions.Comment,
  error: Core.ActionFailure.Failure,
  body: (input) => GitHub.Actions.CommentOnIssue.call(input)
})

const layer = (env: Environment) =>
  Layer.mergeAll(GitHub.Actions.layer, Interpreter.layer(CommentFlow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, GitHub.GitHubClient.layer({}, env), NodeCrypto.layer))
  )

/** Posts the comment; the engine journals the result under `executionId`. */
export effect function comment(env: Environment, input: typeof GitHub.Actions.CommentOnIssuePayload.Type) {
  const live = layer(env)
  return try scoped(effect {
    provide live {
      return try CommentFlow.execute(input, { executionId: "run-comment-flow" })
    }
  })
}
```

## Next steps

- [GitHub guide](./guides/github.md): authenticate as the App, paginate, stay
  inside rate limits, and write issues and comments idempotently.
