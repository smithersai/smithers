/**
 * `organization/qualify`: one attempt at one qualification case.
 *
 * A case (`Org/Cases/<id>.md`) gives one principal a task and the context it
 * would retrieve. The attempt pins the roster, runs the principal's turn the
 * way a delivery does (composed under its own host and seat, checked against
 * its charter, asked again once when a result breaks it), in a workspace
 * machine of the case's repository when the case needs one, and writes
 * the answer, or the failure that stopped it, as a receipt under the
 * organization's generated directory. Scoring against the case's
 * expectations is the `qualify` command's (`qualify/cases.ts`); the flow only
 * records what the principal answered.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import * as Prompt from "../../../packages/smithers/agent/organization/src/Prompt.ts"
import { turn } from "../deliver/flow.ts"
import { Answer, Describe, RequestKey, type Stage, StepFailure } from "../schema.ts"

const implementationVersion = "organization/qualify/v2"

/** What one attempt recorded: the checked answer, or why there is none. */
export const Outcome = Schema.Struct({
  answer: Schema.optionalKey(Answer),
  failure: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
})
export type Outcome = typeof Outcome.Type

/** One attempt: its key and the wiki path of the receipt holding its {@link Outcome}. */
export const Attempt = Schema.Struct({ key: RequestKey, receipt: Schema.String })
export type Attempt = typeof Attempt.Type

type Payload = {
  readonly key: string
  readonly principal: string
  readonly task: Profile.TaskContract
}

/** The attempt's receipt, and the attempt it records. */
const record = (payload: Payload, outcome: unknown): Node.Node<Attempt, typeof Actions.ReceiptFailed.Type, any> =>
  Actions.WriteReceipt.call({
    runId: payload.key,
    name: "qualify",
    // Planned references resolve wherever they sit; the declared types cannot say so.
    receipt: { principal: payload.principal, task: payload.task, outcome } as never
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
      Node.succeed({ key: payload.key, receipt: written.path } as unknown as Attempt)))
  ) as Node.Node<Attempt, typeof Actions.ReceiptFailed.Type, any>

/** Run one qualification attempt. */
export default Flow.make("organization/qualify", {
  description:
    "Run one qualification attempt: one principal's task over fixture context, answered under its own seat, checked against its charter, and recorded as a receipt.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: {
    key: RequestKey,
    principal: Profile.PrincipalId,
    task: Profile.TaskContract,
    context: Schema.Array(Prompt.ContextEntry),
    /**
     * A repository to work in: the principal's turn runs in a workspace
     * machine seeded from its checked-out commit, removed when the turn ends.
     */
    repository: Schema.optionalKey(Profile.Container)
  },
  success: Attempt,
  error: Actions.ReceiptFailed,
  body: (payload) => {
    const stage: Stage = {
      proceed: true,
      outcome: "blocked",
      reason: "",
      principal: payload.principal,
      task: payload.task,
      context: payload.context
    }
    const repository = payload.repository
    return Actions.PinRoster.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
        Node.succeed(stage).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (planned) =>
            repository === undefined
              ? turn(pin.revision, planned)
              : Actions.PrepareWorkspace.call({ repository, commit: "HEAD", slug: "qualify" }).pipe(
                Node.bindPlanned(Node.capture({ implementationVersion }, (prepared) =>
                  turn(pin.revision, planned, { key: prepared.key, repository, commit: prepared.commit }).pipe(
                    Node.catch({
                      onFailure: Node.capture({ implementationVersion }, (failure) =>
                        Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(
                          Node.andThen(Node.fail(failure as Planned.Planned<typeof StepFailure.Type>))
                        ))
                    }),
                    // Removed once the turn has answered, never beside it.
                    Node.bindPlanned(Node.capture({ implementationVersion }, (answer) =>
                      Node.andThen(Node.succeed(answer), Actions.DisposeWorkspace.call({ workspace: prepared })).pipe(
                        Node.andThen(Node.succeed(answer))
                      )))
                  )))
              )))
        ))),
      Node.map(Node.capture({ implementationVersion }, (answer): Outcome => ({ answer }))),
      Node.catch({
        onFailure: Node.capture({ implementationVersion }, (failure) =>
          Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
            Node.map(Node.capture({ implementationVersion }, (described): Outcome => ({ failure: described })))
          ))
      }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => record(payload, outcome)))
    )
  }
})
