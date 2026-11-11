/**
 * The authored `notification-policy` flow: its real graph (node ids, order and
 * schemas), its deterministic rule, its place in this repository's catalog,
 * and the copyability that keeps it free of the app. The flow's agreement with
 * the app's contract is proved where the contract lives:
 * `apps/mvp/worker/NotificationPolicy.test.ts` runs this flow through
 * `RecipientPolicy.layerFlow` on requests the notification writer builds.
 */
import * as Graph from "@smthrs/core/Graph"
import { Schema } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import NotificationPolicy from "../notification-policy/flow.ts"
import {
  decide,
  Decision,
  NOTIFICATION_POLICY_DECIDE_ACTION,
  NOTIFICATION_POLICY_KINDS,
  NOTIFICATION_RECIPIENT_LIMIT,
  Request
} from "../notification-policy/src/policy.ts"

const request: typeof Request.Type = {
  repoId: "github/maya/app",
  kind: "needs_you",
  subject: "run-12",
  revision: "3",
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
    "FlowCall:root:notification-policy"
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

test("a run that needs an answer tells its launcher; every other notice tells everyone who can read it", () => {
  assert.deepEqual(decide(request).recipients, ["maya"])
  // A repository event has no launcher, so nobody is singled out.
  const { owner: _, ...withoutOwner } = request
  assert.deepEqual(decide(withoutOwner).recipients, ["maya", "ben"])
  for (const kind of NOTIFICATION_POLICY_KINDS.filter((kind) => kind !== "needs_you")) {
    const answer = decide({ ...request, kind })
    assert.deepEqual(Schema.decodeUnknownSync(Decision)(answer), answer)
    assert.deepEqual(answer.recipients, ["maya", "ben"])
  }
})

test("the request and the decision refuse what the app never sends or accepts", () => {
  for (
    const broken of [
      { ...request, repoId: "-leading-dash" },
      { ...request, owner: "an email@example.com" },
      { ...request, kind: "invented" },
      { ...request, candidates: "maya" }
    ]
  ) {
    assert.throws(() => Schema.decodeUnknownSync(Request)(broken))
  }
  const tooMany = { recipients: Array.from({ length: NOTIFICATION_RECIPIENT_LIMIT + 1 }, () => "maya") }
  assert.throws(() => Schema.decodeUnknownSync(Decision)(tooMany))
  assert.deepEqual(Schema.decodeUnknownSync(Decision)({ recipients: ["maya"], note: "ghp_token" }), {
    recipients: ["maya"]
  })
})

test("the flow is discovered into this repository's own catalog as a pure, human-only flow", async () => {
  const projection = JSON.parse(await readFile(new URL("../../factory.json", import.meta.url), "utf8")) as {
    readonly flows: ReadonlyArray<Record<string, unknown>>
  }
  const row = projection.flows.find((flow) => flow.id === "notification-policy")
  assert.ok(row, "notification-policy is missing from .smithers/factory.json")
  assert.equal(row.path, ".smithers/flows/notification-policy/flow.ts")
  assert.equal(row.kind, "ts")
  assert.equal(row.modelInvocable, false)
  assert.deepEqual(row.capabilities, [])
})

test("the copyable flow imports only published packages", async () => {
  // A maintainer copies `.smithers/flows/notification-policy/` into their own
  // repository, where no path into this monorepo resolves, so the example
  // depends on published packages alone and restates the app's shapes.
  const importsOf = async (path: string) => {
    const source = await readFile(new URL(path, import.meta.url), "utf8")
    return [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((match) => match[1])
  }
  assert.deepEqual(await importsOf("../notification-policy/src/policy.ts"), ["@smthrs/flow", "effect"])
  assert.deepEqual(await importsOf("../notification-policy/flow.ts"), [
    "@smthrs/flow",
    "@smthrs/plan",
    "effect",
    "./src/policy.ts"
  ])
})
