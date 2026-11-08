/**
 * The authored `notification-policy` flow: its real graph (node ids, order and
 * schemas), its deterministic rule, and the agreement between its Effect
 * Schema wire shapes and the app's own zod contract, which is the only thing
 * that keeps the two sides of one decision from drifting apart.
 */
import * as Graph from "@smthrs/core/Graph"
import { Schema } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import {
  NOTIFICATION_POLICY_DECIDE_ACTION,
  NOTIFICATION_POLICY_EVENT,
  NOTIFICATION_POLICY_FLOW_TAG,
  NOTIFICATION_POLICY_KINDS,
  NOTIFICATION_RECIPIENT_LIMIT,
  NotificationPolicyDecisionSchema,
  notificationPolicyDeclaration,
  NotificationPolicyRequestSchema,
  notificationPolicyResult
} from "../../../packages/rpc/src/NotificationPolicy.ts"
import NotificationPolicy from "../notification-policy/flow.ts"
import {
  decide,
  Decision,
  NOTIFICATION_POLICY_DECIDE_ACTION as FLOW_DECIDE_ACTION,
  NOTIFICATION_POLICY_KINDS as FLOW_KINDS,
  NOTIFICATION_RECIPIENT_LIMIT as FLOW_RECIPIENT_LIMIT,
  Request
} from "../notification-policy/src/policy.vibe"

const request = {
  repo: "maya/app",
  event: { kind: "needs_you" as const, entryId: "todo.needs-you.12.wait-question-1", todo: 12 },
  owner: "maya",
  candidates: ["maya", "ben"],
  defaults: ["maya", "ben"]
}

const built = () => Graph.build(NotificationPolicy, request)
/** The action or flow tag a graph node's own key material records. */
const tagOf = (node: { readonly draft: { readonly material: unknown } }): string => {
  const body = (node.draft.material as { readonly body: Record<string, unknown> }).body
  return String(body.action ?? body.flow)
}

test("the flow is one deciding action feeding its entry, declared pure, never a model's guess", () => {
  const graph = built()
  assert.deepEqual(Graph.diagnostics(graph), [])
  const nodes = Graph.nodes(graph)
  // The real plan: the deciding action runs first and its value becomes the
  // flow call's result. Both ids are the plan's own, and the tags are the
  // declarations behind them.
  assert.deepEqual(nodes.map((node) => `${node.kind}:${node.id}:${tagOf(node)}`), [
    `ActionCall:root.flow:${NOTIFICATION_POLICY_DECIDE_ACTION}`,
    `FlowCall:root:${NOTIFICATION_POLICY_FLOW_TAG}`
  ])
  assert.deepEqual(Graph.edges(graph).map((edge) => `${edge.from}->${edge.to}:${edge.reason}`), [
    "root.flow->root:value"
  ])
  assert.deepEqual(nodes.map((node) => [...node.dependencies]), [[], ["root.flow"]])
  // No capability, no read, no write, no model seat: a routing rule declares,
  // it does not act, so a policy run can never reach repository content.
  assert.deepEqual(nodes.flatMap((node) => [...node.capabilities]), [])
  assert.equal(
    NotificationPolicy.description,
    "Decide who is told about a repository notification, among the people who can already read it."
  )
})

test("the deciding node carries the request it was called with, as its declared schema", () => {
  const action = Graph.nodes(built()).find((node) => node.kind === "ActionCall")
  assert.ok(action)
  assert.deepEqual(Schema.decodeUnknownSync(Request)(action.payload), request)
  // The wire shape is closed: an answer or a request with an extra key is not
  // this action's shape, so no diagnostic can ride one through the plan.
  const declaration = (action.draft.material as {
    readonly body: {
      readonly declaration: {
        readonly payload: { readonly schema: { readonly additionalProperties?: unknown } }
        readonly success: { readonly schema: { readonly additionalProperties?: unknown } }
      }
    }
  }).body.declaration
  assert.equal(declaration.payload.schema.additionalProperties, false)
  assert.equal(declaration.success.schema.additionalProperties, false)
})

test("both branches of the rule route differently from the built-in audience", () => {
  for (const kind of ["needs_you", "approval", "conflict"] as const) {
    assert.deepEqual(decide({ ...request, event: { ...request.event, kind } }).recipients, ["maya"])
  }
  for (const kind of ["in_review", "failed", "merged"] as const) {
    assert.deepEqual(decide({ ...request, event: { ...request.event, kind } }).recipients, ["maya", "ben"])
  }
  // Every routable kind the app can ask about has an answer here.
  for (const kind of NOTIFICATION_POLICY_KINDS) {
    const answer = decide({ ...request, event: { ...request.event, kind } })
    assert.deepEqual(Schema.decodeUnknownSync(Decision)(answer), answer)
    assert.ok(answer.recipients.length > 0)
  }
})

test("the flow's wire shapes and the app's contract accept and refuse the same values", () => {
  assert.deepEqual(Schema.decodeUnknownSync(Request)(request), request)
  assert.equal(NotificationPolicyRequestSchema.safeParse(request).success, true)
  for (
    const broken of [
      { ...request, repo: "no-owner" },
      { ...request, owner: "-bad-login" },
      { ...request, event: { ...request.event, kind: "invented" } },
      { ...request, candidates: [] }
    ]
  ) {
    assert.equal(NotificationPolicyRequestSchema.safeParse(broken).success, false)
    assert.throws(() => Schema.decodeUnknownSync(Request)(broken))
  }
  const answer = decide(request)
  assert.equal(NotificationPolicyDecisionSchema.safeParse(answer).success, true)
  // A decision carrying anything beyond recipients and handling is refused by
  // both sides, so no diagnostic, URL or secret value can ride an answer out.
  for (
    const [smuggled, kept] of [
      [{ recipients: ["maya"], note: "ghp_token" }, { recipients: ["maya"] }],
      [{ recipients: ["maya"], handling: { quiet: true, detail: "stack trace" } }, {
        recipients: ["maya"],
        handling: { quiet: true }
      }]
    ] as const
  ) {
    assert.equal(NotificationPolicyDecisionSchema.safeParse(smuggled).success, false)
    // The flow's own shape carries neither extra key out of the run either.
    assert.deepEqual(Schema.decodeUnknownSync(Decision)(smuggled), kept)
  }
})

test("this repository's own answer, routed through the app's access check, narrows the audience", () => {
  const outcome = notificationPolicyResult(request, decide(request))
  assert.deepEqual([...outcome.recipients], ["maya"])
  assert.deepEqual([...outcome.withheld], [])
  assert.deepEqual(outcome.stamp, { source: "policy" })
})

test("the flow is discovered into this repository's own catalog as a pure, human-only flow", async () => {
  const projection = JSON.parse(await readFile(new URL("../../factory.json", import.meta.url), "utf8")) as {
    readonly flows: ReadonlyArray<Record<string, unknown>>
  }
  const row = projection.flows.find((flow) => flow.id === NOTIFICATION_POLICY_FLOW_TAG)
  assert.ok(row, "notification-policy is missing from .smithers/factory.json")
  assert.equal(row.path, ".smithers/flows/notification-policy/flow.ts")
  assert.equal(row.kind, "ts")
  assert.equal(row.modelInvocable, false)
  assert.deepEqual(row.capabilities, [])
})

test("the declaration a repository writes for this flow is the one the app reads", () => {
  assert.deepEqual(
    notificationPolicyDeclaration({
      on: [{ event: NOTIFICATION_POLICY_EVENT, flow: NOTIFICATION_POLICY_FLOW_TAG, description: "Choose who is told" }]
    }),
    { kind: "flow", flowId: NOTIFICATION_POLICY_FLOW_TAG }
  )
  assert.deepEqual(notificationPolicyDeclaration({ on: [{ event: "change.opened", flow: "review" }] }), {
    kind: "none"
  })
  // Two claims on one event, or one row naming two flows, is not a policy.
  assert.deepEqual(
    notificationPolicyDeclaration({
      on: [
        { event: NOTIFICATION_POLICY_EVENT, flow: "a" },
        { event: NOTIFICATION_POLICY_EVENT, flow: "b" }
      ]
    }),
    { kind: "ambiguous" }
  )
  assert.deepEqual(
    notificationPolicyDeclaration({ on: [{ event: NOTIFICATION_POLICY_EVENT, flow: ["a", "b"] }] }),
    { kind: "ambiguous" }
  )
})

test("the copyable flow restates the app's three constants and never reaches into @smthrs/rpc", async () => {
  // `@smthrs/rpc` is private to this monorepo. A maintainer copies
  // `.smithers/flows/notification-policy/` into their own repository, where that path
  // does not resolve, so the example depends on `@smthrs/flow` and `effect`
  // alone and restates what it borrows. These assertions are the drift guard
  // that restating costs: the app owns the values, this file only repeats them.
  assert.equal(FLOW_DECIDE_ACTION, NOTIFICATION_POLICY_DECIDE_ACTION)
  assert.deepEqual([...FLOW_KINDS], [...NOTIFICATION_POLICY_KINDS])
  assert.equal(FLOW_RECIPIENT_LIMIT, NOTIFICATION_RECIPIENT_LIMIT)
  const source = await readFile(new URL("../notification-policy/src/policy.vibe", import.meta.url), "utf8")
  const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((match) => match[1])
  assert.deepEqual(imports, ["@smthrs/flow"])
})

test("the app resolves a declaration naming a repository's own flow, not only this one's", () => {
  // The consumer proof in lane 86's receipts projects exactly this row from
  // an ordinary repository's `.smithers/FACTORY.ts` with the published SDK.
  assert.deepEqual(
    notificationPolicyDeclaration({
      on: [{ event: NOTIFICATION_POLICY_EVENT, flow: "team-notification-policy", description: "Choose who is told" }]
    }),
    { kind: "flow", flowId: "team-notification-policy" }
  )
})
