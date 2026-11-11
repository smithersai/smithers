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
