/**
 * `organization/deliver`: one admitted request carried from the assistant to
 * a landed branch.
 *
 * The assistant routes the request; the role it hands off to (the lead)
 * writes a contract naming a builder and an independent checker; the builder
 * works in a microVM workspace; the change is collected, checked in a fresh
 * machine, and judged by the checker, for at most `maxRounds` rounds; an
 * approved change lands on a branch of the host repository, never the
 * checked-out one and never pushed. Every ending, including a failure, writes
 * a receipt under the organization's generated directory and, for a Slack
 * request, replies in its thread.
 *
 * Gates attach at two named boundaries, from the admission's policy:
 *
 * - `task` / `organization/deliver`, before the builder starts, about the
 *   request and the assignment;
 * - `external-write` / `organization/apply-change`, before the change lands,
 *   about the patch digest, the files, and the check result.
 *
 * An empty policy adds no node.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Slack from "../../../packages/smithers/agent/integrations/src/slack/Actions.ts"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Gates from "../../../packages/smithers/agent/organization/src/Gates.ts"
import type * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import {
  Admission,
  Answer,
  Assign,
  type Assignment,
  BuildTask,
  CheckTask,
  CorrectTask,
  Decide,
  DeliveryFailed,
  Describe,
  LeadTask,
  RenderReply,
  Report,
  Request,
  RouteTask,
  Settle,
  type Stage,
  StepFailure
} from "../schema.ts"
import { slackConnection } from "../slack-connection.ts"

const implementationVersion = "organization/deliver/v3"

/** The boundary the builder's task crosses. */
export const taskGate: Gates.At = { boundary: "task", target: "organization/deliver" }
/** The boundary a landing crosses. */
export const landGate: Gates.At = { boundary: "external-write", target: "organization/apply-change" }

type Payload = { readonly request: typeof Request.Type; readonly admission: typeof Admission.Type }

type TurnWorkspace = {
  readonly key: Planned.Planned<string>
  readonly repository: string
  readonly commit: Planned.Planned<string>
}

/** One ask: compose, run under the principal's own host, check against its charter. */
const ask = (revision: Planned.Planned<string>, stage: Planned.Planned<Stage>, workspace?: TurnWorkspace) =>
  Actions.ComposeTask.call({
    revision,
    principal: stage.principal,
    task: stage.task,
    context: stage.context,
    // The key and commit are planned references the engine resolves inside the struct.
    ...(workspace === undefined
      ? {}
      : { workspace: workspace as unknown as { key: string; repository: string; commit: string } })
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (payload) => Actions.RoleTask.call(payload))),
    Node.bindPlanned(Node.capture({ implementationVersion }, (result) =>
      Node.all({
        principal: Node.succeed(stage.principal),
        result: Node.succeed(result),
        validation: Actions.ValidateResult.call({ revision, principal: stage.principal, result })
      })))
  )

/**
 * One principal's turn. A `done` result that breaks the charter is asked
 * again once, with the violations in its context; the second answer stands.
 */
const turn = (revision: Planned.Planned<string>, stage: Planned.Planned<Stage>, workspace?: TurnWorkspace) =>
  ask(revision, stage, workspace).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (seen) => !seen.validation.valid && seen.result.status === "done"),
      then: (seen) =>
        CorrectTask.call({ stage, result: seen.result, validation: seen.validation }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (corrected) => ask(revision, corrected, workspace)))
        ),
      else: (seen) => Node.succeed(seen)
    }),
    Node.map(Node.capture({ implementationVersion }, (seen): Answer => ({
      principal: seen.principal,
      result: seen.result,
      valid: seen.validation.valid,
      violations: seen.validation.violations.map((violation) => violation.message)
    })))
  )

type Failure = typeof StepFailure.Type

/**
 * A report node. `fields` may hold planned references, which the engine
 * resolves wherever they sit; the declared type cannot say so.
 */
const report = (payload: Payload, fields: Readonly<Record<string, unknown>>): Node.Node<Report> =>
  Node.succeed({ key: payload.request.key, ...fields } as unknown as Report)

/** One build-collect-check-judge round, and the next one while the checker asks for changes. */
const round = (
  payload: Payload,
  revision: Planned.Planned<string>,
  assignment: Planned.Planned<Assignment>,
  prepared: Planned.Planned<Workspace.Prepared>,
  n: number,
  findings: Planned.Planned<ReadonlyArray<string>> | ReadonlyArray<string>
): Node.Node<Report, Failure, any> => {
  const { admission, request } = payload
  const principals = {
    assistant: admission.assistant,
    lead: assignment.lead,
    builder: assignment.builder,
    checker: assignment.checker
  }
  return BuildTask.call({ request, assignment, workdir: prepared.workdir, round: n, findings }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (stage) =>
      turn(revision, stage, { key: prepared.key, repository: admission.repository, commit: prepared.commit }))),
    // The diff is read only after the builder's turn has finished: a step
    // that does not consume a reference may otherwise start beside it.
    Node.bindPlanned(Node.capture({ implementationVersion }, (build) =>
      Node.andThen(Node.succeed(build), Actions.CollectDiff.call({ workspace: prepared })).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (diff) =>
          Actions.RunChecks.call({
            repository: admission.repository,
            commit: prepared.commit,
            patch: diff.patch,
            checks: admission.checks
          }).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (checks) =>
              CheckTask.call({ request, assignment, workdir: prepared.workdir, round: n, build, diff, checks }).pipe(
                // A checker that holds a workspace in the repository reproduces
                // the change in the builder's machine; any other judges the
                // diff and the receipts it is given.
                Node.branch({
                  if: Node.capture({ implementationVersion }, (stage) => stage.workspace === true),
                  then: (stage) =>
                    turn(revision, stage, { key: prepared.key, repository: admission.repository, commit: prepared.commit }),
                  else: (stage) => turn(revision, stage)
                }),
                Node.bindPlanned(Node.capture({ implementationVersion }, (check) =>
                  Decide.call({ build, check, checks, diff }).pipe(
                    Node.branch({
                      if: Node.capture({ implementationVersion }, (verdict) => verdict.approved),
                      then: () =>
                        Gates.before(
                          admission.gates,
                          landGate,
                          {
                            repository: admission.repository,
                            branch: admission.branch,
                            parent: prepared.commit,
                            patchDigest: diff.digest,
                            files: diff.files,
                            checksPassed: checks.passed,
                            approvedBy: assignment.checker
                          },
                          Actions.ApplyChange.call({
                            repository: admission.repository,
                            branch: admission.branch,
                            parent: prepared.commit,
                            patch: diff.patch,
                            message: assignment.message,
                            principal: assignment.builder,
                            at: admission.at
                          })
                        ).pipe(
                          Node.bindPlanned(Node.capture({ implementationVersion }, (applied) =>
                            Node.andThen(Node.succeed(applied), Actions.DisposeWorkspace.call({ workspace: prepared })).pipe(
                              Node.andThen(report(payload, {
                                status: "landed",
                                summary: check.result.summary,
                                principals,
                                rounds: n,
                                applied
                              }))
                            )))
                        ),
                      else: (verdict) =>
                        n >= admission.maxRounds
                          ? Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(
                            Node.andThen(report(payload, {
                              status: "changes-requested",
                              summary: check.result.summary,
                              principals,
                              rounds: n,
                              findings: verdict.findings
                            }))
                          )
                          : round(payload, revision, assignment, prepared, n + 1, verdict.findings)
                    })
                  )))
              )))
          )))
      )))
  ) as Node.Node<Report, Failure, any>
}

/** Routing, the contract, the gated build, and every early ending, as one report. */
const work = (payload: Payload) => {
  const { admission, request } = payload
  return Actions.PinRoster.call({}).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
      RouteTask.call({ revision: pin.revision, assistant: admission.assistant, request }).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (stage) => turn(pin.revision, stage))),
        Node.bindPlanned(Node.capture({ implementationVersion }, (routed) =>
          LeadTask.call({ revision: pin.revision, request, repository: admission.repository, routed }).pipe(
            Node.branch({
              if: Node.capture({ implementationVersion }, (stage) => stage.proceed),
              else: (stage) =>
                report(payload, {
                  status: stage.outcome,
                  summary: stage.reason,
                  principals: { assistant: admission.assistant },
                  rounds: 0
                }),
              then: (stage) =>
                turn(pin.revision, stage).pipe(
                  Node.bindPlanned(Node.capture({ implementationVersion }, (contract) =>
                    Assign.call({ revision: pin.revision, repository: admission.repository, contract }).pipe(
                      Node.branch({
                        if: Node.capture({ implementationVersion }, (assignment) => assignment.proceed),
                        else: (assignment) =>
                          report(payload, {
                            status: "blocked",
                            summary: assignment.reason,
                            principals: { assistant: admission.assistant, lead: contract.principal },
                            rounds: 0
                          }),
                        then: (assignment) =>
                          progress(payload, contract.principal, assignment.objective, "contract").pipe(
                            Node.andThen(Gates.before(
                              admission.gates,
                              taskGate,
                              { request: request.text, assignment },
                              Actions.PrepareWorkspace.call({
                                repository: admission.repository,
                                commit: admission.commit,
                                slug: "build"
                              }).pipe(
                                Node.bindPlanned(Node.capture({ implementationVersion }, (prepared) =>
                                  round(payload, pin.revision, assignment, prepared, 1, [])))
                              )
                            ))
                          )
                      })
                    )))
                )
            })
          )))
      )))
  )
}

/** A progress post in the request's thread, or nothing for a request with no thread. */
const progress = (
  payload: Payload,
  speaker: Planned.Planned<string> | string,
  text: Planned.Planned<string> | string,
  step: string
): Node.Node<unknown, Failure, any> => {
  const conversation = payload.request.conversation
  if (conversation === undefined) return Node.succeed(undefined)
  return RenderReply.call({ speaker, text }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (reply) =>
      Slack.PostMessage.call({
        connectionId: slackConnection,
        channel: conversation.channel,
        threadTs: conversation.thread,
        text: reply.text,
        key: `${payload.request.key}/${step}`,
        persona: reply.persona
      })))
  )
}

/** Receipt, reply, and the run's own ending, for any report. */
const finish = (payload: Payload, outcome: Planned.Planned<Report>) =>
  Actions.WriteReceipt.call({
    runId: payload.request.key,
    name: "deliver",
    receipt: { request: payload.request, admission: payload.admission, report: outcome }
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
      progress(payload, payload.admission.assistant, outcome.summary, "result").pipe(
        Node.andThen(Settle.call({ report: outcome, receipt: written.path }))
      )))
  )

/** Deliver one admitted request. */
export default Flow.make("organization/deliver", {
  description:
    "Deliver one admitted owner request through the organization: the assistant routes it, a lead writes the contract, a builder changes the repository in a microVM workspace, the change is checked in a fresh microVM and judged by an independent checker, and an approved change lands on a branch with a receipt.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.request.key,
  payload: { request: Request, admission: Admission },
  success: Report,
  error: Schema.Union([DeliveryFailed, StepFailure]),
  body: (payload) =>
    work(payload).pipe(
      Node.catch({
        onFailure: Node.capture({ implementationVersion }, (failure) =>
          Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
            Node.map(Node.capture({ implementationVersion, key: payload.request.key }, function(described): Report {
              return {
              key: this.key,
              status: "failed",
              summary: `${described.code}: ${described.message}`,
              principals: {},
              rounds: 0
              }
            }))
          ))
      }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => finish(payload, outcome as Planned.Planned<Report>)))
    )
})
