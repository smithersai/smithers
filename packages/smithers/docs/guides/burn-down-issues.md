---
title: "Burn down a repository's issues"
description: "Host the Burndown pattern with smthrs flow start: one flow file works every open issue of a GitHub repository as a durable child, with nothing installed in the project."
---

`smthrs flow start` is the host for a [Burndown](../../flows/patterns/docs/burndown.md).
The project needs one flow file. The installed CLI supplies the pattern, the
GitHub client and the flow engine, so there is no package to install and no
checkout of Smithers to build. The version of `smthrs` you installed is the
version every run uses.

```text
your repository                       smthrs (installed once)
└─ .smithers/flows/issues/flow.ts ──▶ @smthrs/patterns   Burndown
                                      @smthrs/integrations  GitHub client
                                      @smthrs/flow, effect  engine and runtime
```

## Write the flow

Save this as `.smithers/flows/issues/flow.ts`:

```ts
import { Action, Flow, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Burndown } from "@smthrs/patterns"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

const Input = Schema.Struct({ repo: Schema.String, label: Schema.optional(Schema.String) })
const Issue = Schema.Struct({ id: Schema.String, number: Schema.Number, title: Schema.String })
const Report = Schema.Struct({ changed: Schema.String })
// The fields of a GitHub issue this flow reads. A pull request is an issue with `pull_request`.
const Listed = Schema.Array(
  Schema.Struct({ number: Schema.Number, title: Schema.String, pull_request: Schema.optionalKey(Schema.Unknown) })
)

const ListIssues = Action.make("issues/list", {
  payload: { input: Input, round: Schema.Number },
  success: Schema.Array(Issue),
  error: Schema.String,
  nondeterministic: true
})
const Accounts = Action.make("issues/accounts", {
  payload: { input: Input, round: Schema.Number },
  success: Burndown.Capacity,
  nondeterministic: true
})
const Dispatch = Burndown.dispatch("issues/dispatch")

// The work on one issue, a durable child per issue. Put your agent in Fix.
const Fix = Action.make("issues/fix", {
  payload: { repo: Schema.String, number: Schema.Number, title: Schema.String },
  success: Report,
  nondeterministic: true
})
const Work = Flow.make("issues/work", {
  payload: Fix.payloadSchema,
  success: Report,
  body: (input) => Fix.call(input)
})

const Rounds = Burndown.make({
  name: "issues/rounds",
  discover: ListIssues,
  capacity: Accounts,
  dispatch: Dispatch,
  maxRounds: 50,
  deadline: "12 hours"
})

const listOpen = ({ input }: { readonly input: typeof Input.Type }) =>
  Effect.gen(function*() {
    const client = yield* GitHub.GitHubClient.GitHubClient
    const label = input.label === undefined ? "" : `&labels=${encodeURIComponent(input.label)}`
    const page = yield* client.paginate(`/repos/${input.repo}/issues?state=open${label}`)
    const issues = yield* Schema.decodeUnknownEffect(Listed)(page.items)
    return issues.filter((issue) => issue.pull_request === undefined).map((issue) => ({
      id: String(issue.number),
      number: issue.number,
      title: issue.title
    }))
  }).pipe(Effect.mapError((error) => error.message))

const work = Burndown.child(
  Work,
  ({ input, item }: Burndown.ItemArgs<typeof Input.Type, typeof Issue.Type>) => ({
    repo: input.repo,
    number: item.number,
    title: item.title
  })
)

// Everything the flow needs to execute. `smthrs flow start` provides it to the engine.
export const layer = Layer.mergeAll(
  ListIssues.toLayer(listOpen),
  Accounts.toLayer(() => Effect.succeed(Burndown.available(4))),
  Fix.toLayer(({ repo, number, title }) => Effect.succeed({ changed: `${repo}#${number}: ${title}` })),
  Burndown.layer(Dispatch, {
    key: "issues",
    concurrency: 4,
    // Take your lock on the issue in claim, and give it back in release.
    claim: () => Effect.void,
    work,
    release: () => Effect.void,
    detail: (report) => report.changed
  }),
  Interpreter.layer(Work),
  Interpreter.layer(Rounds),
  Sleep.layer,
  WaitFor.layer
).pipe(Layer.provide(Layer.orDie(GitHub.GitHubClient.layer())), Layer.provide(FetchHttpClient.layer))

export default Flow.make("issues", {
  description: "Work every open issue of a GitHub repository.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "compensable" },
  modelInvocable: false,
  payload: Input,
  success: Burndown.Result,
  error: Schema.Unknown,
  body: (input) => Rounds.child({ input })
})
```

| Part                 | What it does                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `ListIssues`         | Lists the open issues each round. Pull requests are left out.                                         |
| `Accounts`           | Says how many issues may be in flight. Answer `Burndown.waitUntil` or `Burndown.exhausted` to park.   |
| `Fix` and `Work`     | The work on one issue, run as the durable child `issues/<number>`. Put your agent in `Fix`.           |
| `claim`, `release`   | Your lock on an issue, so two machines do not work the same one.                                      |
| `export const layer` | Every implementation the flow needs. `flow start` provides it to the engine.                          |
| `export default`     | The flow `flow start issues` runs. Its body starts the Burndown's first round.                        |

The [Burndown guide](../../flows/patterns/docs/burndown.md) describes every
member, landing, and what a restart repeats.

## Start it

```bash
smthrs flow start issues --data '{"repo":"acme/app"}' --wait
```

Add `"label":"bug"` to the data to work one label's issues. The GitHub client
reads its token from `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. A public
repository lists without one, within GitHub's limit for anonymous requests.

Without `--wait` the command returns once the run is admitted. Use `-d` to
[launch a detached run](./launch-a-detached-run.md) that outlives the shell.

## Watch it

```bash
smthrs runs show run-1
```

```text
executions[9]{executionId,flowName,status,...}:
  run-1,issues,completed,...
  8df549d7...,issues/rounds,completed,...
  issues/7,issues/work,completed,...
  issues/9,issues/work,completed,...
```

Each issue is the execution `issues/<number>`. A run that starts again with the
same `key` reaches the child that already exists instead of working the issue
twice. The run ends when a round finds no issue left to work. Its result holds
one row per issue: `landed`, `held` or `failed`, with the detail.

## Packages the CLI supplies

A flow file imports these without installing them. They resolve from the
installed CLI, at its version, even when the project has its own copy.

| Package                | Use                                         |
| ---------------------- | ------------------------------------------- |
| `effect`               | The runtime                                 |
| `@smthrs/flow`         | `Flow`, `Action`, `Interpreter`, waits      |
| `@smthrs/plan`         | `Node`                                      |
| `@smthrs/core`         | Shared flow definitions                     |
| `@smthrs/agent`        | `AgentAction` and the model seats           |
| `@smthrs/patterns`     | `Burndown` and the other patterns           |
| `@smthrs/integrations` | The GitHub client, issues, comments, labels |

Any other package a flow imports is installed in the project.
