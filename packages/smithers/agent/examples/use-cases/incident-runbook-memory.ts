/**
 * Triage each incident with everything learned so far, bank new lessons, and compress recurring ones into ratified runbook rules.
 *
 * Port of the 0.x `incident-runbook-memory.jsx`. A recall step reads the ops
 * team's live runbook rules, its lessons on the topic and the on-call fact
 * from the memory store. A triage agent diagnoses the incident with them, and
 * a banker agent writes 1-2 new lessons that the flow saves as notes. Once
 * the recall found at least three lessons, a distiller agent writes one rule
 * that the flow saves as pending and superseding them, and a person ratifies
 * it: approval makes the rule live and removes the lessons from recall;
 * denial fails with `RuleDenied` and leaves the lessons live.
 *
 * 0.x's agents saved notes through `record_lesson` and `propose_runbook_rule` tools; here they return the text and an action saves it with the run's provenance, so the model still writes bodies, never coordinates.
 * 0.x's note `kind` (`lesson`, `runbook-rule`) is the note id's prefix; its topic tag is `scope:<topic>`.
 * `HumanTask` records the person's decision before ratification.
 * `WithMemory` and `.smithers/flows/memory/mine` scope memory the agents reach through tools; these agents have none, so the actions use `MemoryStore` directly.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, FlowRuntime, HumanTask } from "@smthrs/flow"
import { MemoryError } from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One namespace for the team's operational knowledge. */
export const namespace = { kind: "user", id: "ops-team" } as const

/** Distill once the recall finds this many lessons on the topic. */
export const distillThreshold = 3

/** What the team already knows. */
export const Recall = Schema.Struct({
  rules: Schema.Array(Schema.String),
  lessons: Schema.Array(Schema.String),
  lessonIds: Schema.Array(Schema.String),
  onCall: Schema.String,
  lessonCount: Schema.Number
})

/** The triage agent's diagnosis. */
export const Triage = Schema.Struct({
  diagnosis: Schema.String,
  actions: Schema.Array(Schema.String),
  groundedInPriorKnowledge: Schema.Boolean
})

/** The banker's new lessons, before they are saved. */
export const Lessons = Schema.Struct({
  lessons: Schema.Array(
    Schema.String.annotate({ description: "One concrete, reusable lesson (not a description of this incident)." })
  ),
  summary: Schema.String
})

/** The lessons as saved. */
export const Bank = Schema.Struct({ lessonIds: Schema.Array(Schema.String), summary: Schema.String })

/** The distiller's rule, before it is saved. */
export const Distilled = Schema.Struct({
  rule: Schema.String.annotate({ description: "The consolidated runbook rule, standing on its own." }),
  rationale: Schema.String
})

/** The pending rule as saved. */
export const Proposal = Schema.Struct({ ruleNoteId: Schema.String, rationale: Schema.String })

/** The ratified rule. */
export const Ratification = Schema.Struct({ ratifiedNoteId: Schema.String, supersededCount: Schema.Number })

/** What the flow settles with: each step's result, `null` where a step did not run. */
export const Output = Schema.Struct({
  recall: Recall,
  triage: Triage,
  bank: Bank,
  proposal: Schema.NullOr(Proposal),
  ratification: Schema.NullOr(Ratification)
})

/** The durable question a person answers before the write. */
export const approvalTask = "incident-runbook-memory/ratify"

const Approval = Schema.Struct({ approved: Schema.Boolean, note: Schema.String })
const approvalSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, note: { type: "string" } },
  required: ["approved", "note"]
}

/** A person rejected the rule. */
export class RuleDenied extends Schema.TaggedError<RuleDenied>()("examples/IncidentRunbookMemory/RuleDenied", {
  note: Schema.String
}) {}

const numbered = (items: ReadonlyArray<string>, empty: string) =>
  items.length > 0 ? items.map((item, i) => `${i + 1}. ${item}`).join("\n") : empty

/** Reads the live rules, the topic's lessons and the on-call fact. */
export const RecallKnowledge = Action.make("examples/IncidentRunbookMemory/Recall", {
  payload: { topic: Schema.String },
  success: Recall,
  error: MemoryError,
  nondeterministic: true
})

/** Diagnoses the incident with what the team knows. */
export const TriageIncident = AgentAction.make("examples/IncidentRunbookMemory/Triage", {
  payload: {
    incident: Schema.String,
    rules: Schema.Array(Schema.String),
    lessons: Schema.Array(Schema.String),
    onCall: Schema.String
  },
  output: Triage,
  seat,
  system: [
    "You are an on-call triage assistant. Ground your diagnosis in the team's runbook rules and lessons when they apply; say so when they don't."
  ],
  prompt: ({ incident, lessons, onCall, rules }) =>
    `Incident: ${incident}\n\nCurrent on-call: ${onCall}\n\nThe team's ratified runbook rules:\n${
      numbered(rules, "(none yet)")
    }\n\nLessons from past incidents on this topic:\n${
      numbered(lessons, "(none yet — this is a cold start)")
    }\n\nDiagnose the incident and list concrete next actions. Ground your diagnosis in\nthe rules and lessons above where they apply, and set groundedInPriorKnowledge\naccordingly — be honest when prior knowledge didn't help.`
})

/** Writes the incident's new lessons. */
export const ExtractLessons = AgentAction.make("examples/IncidentRunbookMemory/Bank", {
  payload: { incident: Schema.String, topic: Schema.String, existingLessons: Schema.Array(Schema.String) },
  output: Lessons,
  seat,
  system: [
    "You extract durable operational lessons from incidents. Each lesson must be reusable by someone who never saw this incident."
  ],
  prompt: ({ existingLessons, incident, topic }) =>
    `Incident just triaged: ${incident}\n\nLessons the team has ALREADY banked on "${topic}":\n${
      numbered(existingLessons, "(none)")
    }\n\nExtract 1-2 NEW durable lessons this incident teaches — reusable statements a\nfuture responder can act on without knowing this incident. Skip anything the\nexisting lessons already cover. If this incident teaches nothing new, return no\nlessons and say so in the summary.`
})

/**
 * Saves the new lessons as notes. Each save creates a note, so it is
 * irreversible with no idempotency key and runs at most once.
 */
export const RecordLessons = Action.make("examples/IncidentRunbookMemory/RecordLessons", {
  payload: { topic: Schema.String, lessons: Lessons },
  success: Bank,
  error: MemoryError,
  nondeterministic: true,
  tier: "irreversible"
})

/** Writes one rule that replaces the recurring lessons. */
export const DistillRule = AgentAction.make("examples/IncidentRunbookMemory/Distill", {
  payload: { topic: Schema.String, lessons: Schema.Array(Schema.String) },
  output: Distilled,
  seat,
  system: [
    "You distill repeated operational lessons into one clear runbook rule. Never lose information the lessons agree on; never invent policy they don't support."
  ],
  prompt: ({ lessons, topic }) =>
    `The team has accumulated these lessons on "${topic}":\n\n${
      numbered(lessons, "")
    }\n\nThey keep recurring — distill them into ONE runbook rule that replaces them all.\nThe rule must stand on its own for a responder who has read none of the lessons,\npreserve everything the lessons agree on, and invent no policy they don't support.\n\nThe rule is recorded as PENDING — a human approves or rejects it at the gate, so\nwrite it to survive that review. Return the rule and a one-paragraph rationale.`
})

/**
 * Saves the rule as pending, superseding the lessons it replaces. The save
 * creates a note, so it is irreversible with no idempotency key and runs at
 * most once.
 */
export const ProposeRule = Action.make("examples/IncidentRunbookMemory/ProposeRule", {
  payload: { topic: Schema.String, distilled: Distilled, lessonIds: Schema.Array(Schema.String) },
  success: Proposal,
  error: MemoryError,
  nondeterministic: true,
  tier: "irreversible"
})

/**
 * Accepts the rule, which takes the lessons it supersedes out of recall.
 * Ratifying a note twice leaves it ratified, so the note id is its
 * idempotency key.
 */
export const RatifyRule = Action.make("examples/IncidentRunbookMemory/Ratify", {
  payload: { ruleNoteId: Schema.String, supersedes: Schema.Array(Schema.String) },
  success: Ratification,
  error: MemoryError,
  nondeterministic: true,
  tier: "irreversible",
  idempotencyKey: ({ ruleNoteId }) => ({ ratify: ruleNoteId })
})

/** The ratification a person must approve. */
export const Ratify = Flow.make("examples/IncidentRunbookMemory/RatifyRule", {
  description: "Accept the approved runbook rule and report the lessons it supersedes.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: { ruleNoteId: Schema.String, supersedes: Schema.Array(Schema.String) },
  success: Ratification,
  error: MemoryError,
  body: Node.capture({}, ({ ruleNoteId, supersedes }) => RatifyRule.call({ ruleNoteId, supersedes }))
})

/** Asks a person, then ratifies only after approval. */
const gatedRatify = (
  ruleNoteId: Planned.Planned<string>,
  distilled: Planned.Planned<typeof Distilled.Type>,
  supersedes: Planned.Planned<ReadonlyArray<string>>
) =>
  Node.bindPlanned(
    Node.map(
      Node.succeed({ ruleNoteId, distilled }),
      Node.capture({}, ({ ruleNoteId, distilled }) =>
        `Ratify the distilled runbook rule\n\n${distilled.rule}\n\nRationale: ${distilled.rationale}\n\nNote: ${ruleNoteId}`)
    ),
    Node.capture({}, (prompt: Planned.Planned<string>) =>
      Node.branch(
        HumanTask.decode(Approval)(
          HumanTask.action.call({ name: approvalTask, kind: "json", prompt, schema: approvalSchema })
        ),
        {
          if: Node.capture({}, (answer) =>
            answer.approved),
          then: Node.capture({}, () =>
            Ratify.call({ ruleNoteId, supersedes })),
          else: Node.capture({}, (answer) =>
            Node.bindPlanned(
              Node.map(Node.succeed({ note: answer.note }), Node.capture({}, ({ note }) => new RuleDenied({ note }))),
              Node.capture({}, (error: Planned.Planned<RuleDenied>) => Node.fail(error))
            ))
        }
      ))
  )

/** The banker writes the lessons, and the flow saves them. */
const bankLessons = (incident: string, topic: string, existingLessons: Planned.Planned<ReadonlyArray<string>>) =>
  Node.bindPlanned(
    ExtractLessons.call({ incident, topic, existingLessons }),
    Node.capture({ topic }, (lessons: Planned.Planned<typeof Lessons.Type>) => RecordLessons.call({ topic, lessons }))
  )

/** Distills, proposes, and ratifies after approval; denial fails before ratification. */
const distill = (topic: string, recall: Planned.Planned<typeof Recall.Type>) =>
  Node.bindPlanned(
    DistillRule.call({ topic, lessons: recall.lessons }),
    Node.capture({ topic }, (distilled: Planned.Planned<typeof Distilled.Type>) =>
      Node.bindPlanned(
        ProposeRule.call({ topic, distilled, lessonIds: recall.lessonIds }),
        Node.capture({}, (proposal: Planned.Planned<typeof Proposal.Type>) =>
          Node.bindPlanned(
            gatedRatify(proposal.ruleNoteId, distilled, recall.lessonIds),
            Node.capture(
              {},
              (ratification: Planned.Planned<typeof Ratification.Type | null>) =>
                Node.succeed({ proposal, ratification })
            )
          ))
      ))
  )

/**
 * The flow: recall, triage, bank, then distill once lessons pile up.
 *
 * Banking and distilling read only the recall, so each waits for the step
 * before it with `Node.andThen`, as 0.x's sequence did.
 */
export const IncidentRunbookMemory = Flow.make("examples/IncidentRunbookMemory", {
  description:
    "Triage each incident with everything learned so far, bank new lessons, and compress recurring ones into ratified runbook rules.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: true,
  payload: { incident: Schema.optional(Schema.String), topic: Schema.optional(Schema.String) },
  success: Output,
  error: Schema.Union([AgentAction.AgentFailure, MemoryError, HumanTask.HumanTaskFailed, RuleDenied]),
  body: Node.capture(
    {},
    ({ incident = "deploys failing, cache tier cold after the weekend scale-down", topic = "deploys" }) => {
      const run = { incident, topic }
      return Node.bindPlanned(
        RecallKnowledge.call({ topic }),
        Node.capture(run, (recall: Planned.Planned<typeof Recall.Type>) =>
          Node.bindPlanned(
            TriageIncident.call({ incident, rules: recall.rules, lessons: recall.lessons, onCall: recall.onCall }),
            Node.capture(run, (triage: Planned.Planned<typeof Triage.Type>) =>
              Node.bindPlanned(
                Node.andThen(Node.succeed(triage), bankLessons(incident, topic, recall.lessons)),
                Node.capture(run, (bank: Planned.Planned<typeof Bank.Type>) =>
                  Node.branch(Node.succeed(recall), {
                    if: Node.capture({}, (known) => known.lessonCount >= distillThreshold),
                    then: Node.capture(run, () =>
                      Node.bindPlanned(
                        Node.andThen(Node.succeed(bank), distill(topic, recall)),
                        Node.capture({}, (
                          distilled: Planned.Planned<{
                            readonly proposal: typeof Proposal.Type
                            readonly ratification: typeof Ratification.Type | null
                          }>
                        ) =>
                          Node.succeed({
                            recall,
                            triage,
                            bank,
                            proposal: distilled.proposal,
                            ratification: distilled.ratification
                          }))
                      )),
                    else: Node.capture(
                      {},
                      () => Node.succeed({ recall, triage, bank, proposal: null, ratification: null })
                    )
                  }))
              ))
          ))
      )
    }
  )
})

const lessonPrefix = "lesson/"
const rulePrefix = "rule/"

/** The memory steps' implementations over the store. */
const memorySteps = Layer.mergeAll(
  RecallKnowledge.toLayer(({ topic }) =>
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      // Only live knowledge: accepted, and not superseded by an accepted note.
      const rules = yield* store.listNotes({ namespace, prefix: rulePrefix })
      // The topic's lessons are the ones banked under its `scope:` tag, whatever
      // words the banker chose.
      const lessons = yield* store.listNotes({
        namespace,
        prefix: lessonPrefix,
        tagGroups: [{ tags: [`scope:${topic}`] }]
      })
      const onCall = yield* store.getFact({ namespace, key: "on-call" })
      return {
        rules: rules.map((note) => note.text),
        lessons: lessons.map((note) => note.text),
        lessonIds: lessons.map((note) => note.id),
        onCall: typeof onCall?.value === "string" ? onCall.value : "unassigned",
        lessonCount: lessons.length
      }
    })
  ),
  RecordLessons.toLayer(({ lessons, topic }) =>
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const { executionId } = yield* FlowRuntime.FlowInstance
      const lessonIds: Array<string> = []
      for (const [i, lesson] of lessons.lessons.entries()) {
        const note = yield* store.putNote({
          namespace,
          id: `${lessonPrefix}${executionId}/${i}`,
          text: lesson,
          tags: [`scope:${topic}`],
          provenance: { runId: executionId, nodeId: "bank", iteration: 0 }
        })
        lessonIds.push(note.id)
      }
      return { lessonIds, summary: lessons.summary }
    })
  ),
  ProposeRule.toLayer(({ distilled, lessonIds, topic }) =>
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const { executionId } = yield* FlowRuntime.FlowInstance
      // Pending until ratified, so the lessons it supersedes stay live.
      const note = yield* store.putNote({
        namespace,
        id: `${rulePrefix}${executionId}`,
        text: distilled.rule,
        tags: [`scope:${topic}`],
        status: "pending",
        supersedes: lessonIds,
        provenance: { runId: executionId, nodeId: "distill", iteration: 0 }
      })
      return { ruleNoteId: note.id, rationale: distilled.rationale }
    })
  ),
  RatifyRule.toLayer(({ ruleNoteId, supersedes }) =>
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.setNoteStatus({ id: ruleNoteId, status: "accepted" })
      // ProposeRule persisted these edges with the pending note. Unlike live
      // namespace counts, that list is unchanged by acceptance or other writes.
      return { ratifiedNoteId: ruleNoteId, supersededCount: new Set(supersedes).size }
    })
  )
).pipe(Layer.provide(Layer.orDie(MemoryStore.layer)))

/** Every model and memory step the flow calls. The interpreter supplies human tasks. */
export const layer = Layer.mergeAll(TriageIncident.layer, ExtractLessons.layer, DistillRule.layer, memorySteps)
