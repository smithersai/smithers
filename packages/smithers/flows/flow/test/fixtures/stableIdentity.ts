import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow, Graph } from "@smthrs/flow"
import { Node, Plan } from "@smthrs/plan"
import { Effect, Schema } from "effect"

const config = Schema.decodeUnknownSync(Schema.Struct({
  offset: Schema.Number,
  implementationVersion: Schema.String,
  changedSource: Schema.Boolean,
  unrelated: Schema.Number,
  stable: Schema.Boolean
}))(JSON.parse(process.argv[2]!))

// Perturb both per-process function ordinals and branch subject allocation.
for (let index = 0; index < config.unrelated; index++) {
  Node.functionIdentity(() => index)
  Node.branch(Node.succeed(index), { if: () => true, then: () => Node.succeed(0), else: () => Node.succeed(1) })
}
const captures = { offset: config.offset, implementationVersion: config.implementationVersion }
const mapper = config.changedSource
  ? Node.capture(captures, (value: number) => value - -captures.offset)
  : Node.capture(captures, (value: number) => value + captures.offset)
const body = ({ seed }: { readonly seed: number }) => Node.map(Node.succeed(seed), mapper)
const flow = Flow.make("stable-identity/process", {
  payload: { seed: Schema.Number },
  success: Schema.Number,
  body: config.stable ? Node.capture(captures, body) : body
})
const graph = Graph.build(flow, { seed: 10 }, { callbackIdentity: config.stable ? "stable" : "process-local" })
const plan = await Effect.runPromise(
  Plan.compile({
    planId: "stable-identity/process-plan",
    flow: flow._tag,
    nodes: Graph.drafts(graph)
  }).pipe(Effect.provide(NodeCrypto.layer))
)
console.log(JSON.stringify({ digest: plan.digest, keys: plan.nodes.map((node) => [node.id, node.key]) }))
