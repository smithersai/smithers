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
import type * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import type * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import {
  Admission,
  AgainTask,
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
  StepFailure,
  DisposeWorkspaces,
  hostFields,
  ReadAsk,
  WriteDocument
} from "../schema.ts"
import Delegate from "../delegate/flow.ts"
import Hire from "../hire/flow.ts"
import MeetingsBook from "../meetings-book/flow.ts"
import { slackConnection } from "../slack-connection.ts"

const implementationVersion = "organization/deliver/v8"

/** Why a builder whose turn left no change is asked again. */
const noChangeAgain =
  "Your turn left no change in the workspace: the collected diff is empty. Make the change the criteria require, read the output of your commands, then answer. If the change cannot be made, answer blocked with the reason."

/** The check an empty change fails, as a report shows it. */
const noChangeCheck = {
  name: Actions.changeCheck,
  exitCode: 1,
  timedOut: false,
  durationMs: 0,
  tail: "no change: the collected diff is empty"
}

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
        // A host field (a hire, a meeting) is an ask of the host, not charter output.
        validation: Node.succeed(result).pipe(
          Node.map(Node.capture({ implementationVersion, hostFields }, function(answer): Profile.RoleResult {
            const fields = { ...answer.fields }
            for (const name of this.hostFields) delete fields[name]
            return { ...answer, fields }
          })),
          Node.bindPlanned(Node.capture({ implementationVersion }, (charterOnly) =>
            Actions.ValidateResult.call({ revision, principal: stage.principal, result: charterOnly })))
        )
      })))
  )

/**
 * One principal's turn. A result that breaks the charter (a missing field
 * on `done`, a field the charter does not declare on any status) is asked
 * again once, with the violations in its context; the second answer stands.
 */
export const turn = (revision: Planned.Planned<string>, stage: Planned.Planned<Stage>, workspace?: TurnWorkspace) =>
  ask(revision, stage, workspace).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (seen) => !seen.validation.valid),
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

/** Every workspace machine a delivery has prepared so far: the builder's, then each round's checker's. */
type Machines = ReadonlyArray<Planned.Planned<Workspace.Prepared> | Planned.Planned<Workspace.Prepared | null>>

/**
 * One build-collect-check-judge round, and the next one while the checker
 * asks for changes. Every machine the delivery prepared stays until it ends
 * (a run parked at a gate resumes into them after a restart), and every
 * ending removes them all.
 */
const round = (
  payload: Payload,
  revision: Planned.Planned<string>,
  assignment: Planned.Planned<Assignment>,
  prepared: Planned.Planned<Workspace.Prepared>,
  n: number,
  findings: Planned.Planned<ReadonlyArray<string>> | ReadonlyArray<string>,
  machines: Machines
): Node.Node<Report, Failure, any> => {
  const { admission, request } = payload
  const principals = {
    assistant: admission.assistant,
    lead: assignment.lead,
    builder: assignment.builder,
    checker: assignment.checker
  }
  const disposeAll = (all: Machines) => DisposeWorkspaces.call({ workspaces: all as never })
  const workspace = { key: prepared.key, repository: admission.repository, commit: prepared.commit }
  // The diff is read only after the builder's turn has finished: a step
  // that does not consume a reference may otherwise start beside it.
  const collected = (build: Planned.Planned<Answer>) =>
    Node.andThen(Node.succeed(build), Actions.CollectDiff.call({ workspace: prepared }))
  // A turn that left no change is asked once more; a second empty change
  // blocks the delivery, and nothing is checked or landed.
  return BuildTask.call({ request, assignment, workdir: prepared.workdir, round: n, findings }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (stage) =>
      turn(revision, stage, workspace).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (build) =>
          collected(build).pipe(
            Node.branch({
              if: Node.capture({ implementationVersion }, (diff) => diff.patch === ""),
              then: () =>
                AgainTask.call({ stage, reason: noChangeAgain }).pipe(
                  Node.bindPlanned(Node.capture({ implementationVersion }, (again) => turn(revision, again, workspace))),
                  Node.bindPlanned(Node.capture({ implementationVersion }, (rebuilt) =>
                    collected(rebuilt).pipe(
                      Node.branch({
                        if: Node.capture({ implementationVersion }, (diff) => diff.patch === ""),
                        then: () =>
                          disposeAll(machines).pipe(
                            Node.andThen(Node.succeed(rebuilt)),
                            Node.map(Node.capture({ implementationVersion }, (answer) =>
                              `no change: ${answer.principal} left no change in the workspace (${answer.result.status}: ${answer.result.summary})`)),
                            Node.bindPlanned(Node.capture({ implementationVersion }, (summary) =>
                              report(payload, {
                                status: "blocked",
                                summary,
                                principals,
                                rounds: n,
                                checks: [noChangeCheck]
                              })))
                          ),
                        else: (diff) => judged(rebuilt, diff)
                      })
                    )))
                ),
              else: (diff) => judged(build, diff)
            })
          )))
      )))
  ) as Node.Node<Report, Failure, any>

  function judged(build: Planned.Planned<Answer>, diff: Planned.Planned<Workspace.Diff>): Node.Node<Report, Failure, any> {
    return Actions.RunChecks.call({
            repository: admission.repository,
            commit: prepared.commit,
            patch: diff.patch,
            checks: admission.checks
          }).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (checks) =>
              CheckTask.call({ request, assignment, workdir: prepared.workdir, round: n, build, diff, checks }).pipe(
                // A checker that holds a workspace in the repository reproduces
                // the change in a machine of its own, seeded from the same
                // commit with the collected change applied; any other judges
                // the diff and the receipts.
                Node.branch({
                  if: Node.capture({ implementationVersion }, (stage) => stage.workspace === true),
                  then: (stage) =>
                    Actions.PrepareWorkspace.call({
                      repository: admission.repository,
                      commit: prepared.commit,
                      slug: `check-${n}`,
                      patch: diff.patch
                    }).pipe(
                      Node.bindPlanned(Node.capture({ implementationVersion }, (checking) =>
                        Node.all({
                          check: turn(revision, stage, {
                            key: checking.key,
                            repository: admission.repository,
                            commit: checking.commit
                          }).pipe(
                            Node.catch({
                              onFailure: Node.capture({ implementationVersion }, (failure) =>
                                disposeAll([...machines, checking]).pipe(
                                  Node.andThen(Node.fail(failure as Planned.Planned<Failure>))
                                ))
                            })
                          ),
                          checking: Node.succeed(checking)
                        })))
                    ),
                  else: (stage) => Node.all({ check: turn(revision, stage), checking: Node.succeed(null) })
                }),
                Node.bindPlanned(Node.capture({ implementationVersion }, (checked) => {
                  const check = checked.check
                  const all: Machines = [...machines, checked.checking]
                  return Decide.call({ build, check, checks, diff }).pipe(
                    Node.branch({
                      if: Node.capture({ implementationVersion }, (verdict) => verdict.approved),
                      then: (verdict) =>
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
                            Node.andThen(Node.succeed(applied), disposeAll(all)).pipe(
                              Node.andThen(report(payload, {
                                status: "landed",
                                summary: check.result.summary,
                                principals,
                                rounds: n,
                                applied,
                                checks: verdict.checks
                              }))
                            )))
                        ),
                      else: (verdict) =>
                        n >= admission.maxRounds
                          ? disposeAll(all).pipe(
                            Node.andThen(report(payload, {
                              status: "changes-requested",
                              summary: check.result.summary,
                              principals,
                              rounds: n,
                              findings: verdict.findings,
                              checks: verdict.checks
                            }))
                          )
                          : round(payload, revision, assignment, prepared, n + 1, verdict.findings, all)
                    }),
                    // A failure after the checker's turn (a declined gate, a
                    // landing refused) removes this round's machines too.
                    Node.catch({
                      onFailure: Node.capture({ implementationVersion }, (failure) =>
                        disposeAll(all).pipe(Node.andThen(Node.fail(failure as Planned.Planned<Failure>))))
                    })
                  )
                }))
              )))
          ) as Node.Node<Report, Failure, any>
  }
}

/** Routing, the contract, the gated build, and every early ending, as one report. */
const work = (payload: Payload) => {
  const { admission, request } = payload
  return Actions.PinRoster.call({}).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
      RouteTask.call({ revision: pin.revision, assistant: admission.assistant, request }).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (stage) => turn(pin.revision, stage))),
        Node.bindPlanned(Node.capture({ implementationVersion }, (routed) =>
          withAsk(payload, routed, () =>
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
                  Node.bindPlanned(Node.capture({ implementationVersion }, (answered) =>
                  withAsk(payload, answered, () => Node.succeed(answered).pipe(
                  Node.branch({
                    // A valid `done` with no handoffs is the role's own answer: a document, not a change.
                    if: Node.capture({ implementationVersion }, (contract) =>
                      contract.valid && contract.result.status === "done" && contract.result.handoffs.length === 0),
                    then: (contract) => documented(payload, pin.revision, contract),
                    else: (contract) =>
                    Assign.call({ revision: pin.revision, key: request.key, repository: admission.repository, contract }).pipe(
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
                          Node.succeed(assignment).pipe(Node.branch({
                            if: Node.capture({ implementationVersion }, (planned) => planned.delegate !== null),
                            then: (planned) =>
                              child(payload, "organization/delegate", contract.principal, Delegate.child(planned.delegate as never)),
                            else: () =>
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
                                  round(payload, pin.revision, assignment, prepared, 1, [], [prepared]).pipe(
                                    // Every ending removes the workspace machine: a failed
                                    // round disposes it before it is reported.
                                    Node.catch({
                                      onFailure: Node.capture({ implementationVersion }, (failure) =>
                                        Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(
                                          Node.andThen(failed(payload, failure))
                                        ))
                                    })
                                  )))
                              )
                            ))
                          )
                          }))
                      })
                    )
                  })
                ))))
                )
            })
          ))))
      )))
  )
}

/**
 * A child flow's ending as the delivery's: its summary answers the request,
 * and a child that did not finish its work blocks it with its reason.
 */
const child = (
  payload: Payload,
  flow: string,
  principal: Planned.Planned<string>,
  run: Node.Node<{ readonly status: string; readonly summary: string; readonly paths: ReadonlyArray<string> }, any, any>
): Node.Node<Report, Failure, any> =>
  run.pipe(
    Node.bindPlanned(Node.capture({ implementationVersion, flow }, function(ended) {
      return report(payload, {
        status: "answered",
        summary: ended.summary,
        principals: { assistant: payload.admission.assistant, lead: principal },
        rounds: 0,
        child: { flow: this.flow, status: ended.status, summary: ended.summary, paths: ended.paths }
      })
    })),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure) =>
        report(payload, {
          status: "blocked",
          summary: (failure as Planned.Planned<{ readonly message: string }>).message,
          principals: { assistant: payload.admission.assistant, lead: principal },
          rounds: 0
        }))
    })
  ) as Node.Node<Report, Failure, any>

/**
 * An answer's asks of the host: a hire runs `organization/hire`, a meeting
 * `organization/meetings-book`, each as a child whose ending ends the
 * delivery; a malformed ask blocks it; with none, `otherwise` goes on.
 */
const withAsk = (
  payload: Payload,
  answer: Planned.Planned<Answer>,
  otherwise: () => Node.Node<Report, Failure, any>
): Node.Node<Report, Failure, any> =>
  ReadAsk.call({ key: payload.request.key, answer }).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (ask) => ask.kind === "none"),
      then: () => otherwise(),
      else: (ask) =>
        Node.succeed(ask).pipe(Node.branch({
          if: Node.capture({ implementationVersion }, (asked) => asked.kind === "hire"),
          then: (asked) => child(payload, "organization/hire", answer.principal, Hire.child(asked.hire as never)),
          else: (asked) =>
            Node.succeed(asked).pipe(Node.branch({
              if: Node.capture({ implementationVersion }, (booking) => booking.kind === "meeting"),
              then: (booking) =>
                child(payload, "organization/meetings-book", answer.principal, MeetingsBook.child(booking.meeting as never)),
              else: (refused) =>
                report(payload, {
                  status: "blocked",
                  summary: refused.reason,
                  principals: { assistant: payload.admission.assistant, lead: answer.principal },
                  rounds: 0
                })
            }))
        }))
    })
  ) as Node.Node<Report, Failure, any>

/** A role's own answer written to the wiki as a document, or why it could not be. */
const documented = (payload: Payload, revision: Planned.Planned<string>, contract: Planned.Planned<Answer>) =>
  WriteDocument.call({ revision, key: payload.request.key, answer: contract }).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (document) => document.written),
      then: (document) =>
        report(payload, {
          status: "answered",
          summary: contract.result.summary,
          principals: { assistant: payload.admission.assistant, lead: contract.principal },
          rounds: 0,
          document: document.path
        }),
      else: (document) =>
        report(payload, {
          status: "blocked",
          summary: document.reason,
          principals: { assistant: payload.admission.assistant, lead: contract.principal },
          rounds: 0
        })
    })
  )

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

/** The report of a delivery a step failure ended. */
const failed = (payload: Payload, failure: unknown): Node.Node<Report, Failure, any> =>
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
  )

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
      Node.catch({ onFailure: Node.capture({ implementationVersion }, (failure) => failed(payload, failure)) }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => finish(payload, outcome as Planned.Planned<Report>)))
    )
})
