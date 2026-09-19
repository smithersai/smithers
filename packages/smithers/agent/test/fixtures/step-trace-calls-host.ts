import * as Cell from "@smthrs/harness/Cell"
import { Descriptor } from "@smthrs/registry"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Option } from "effect"
import type * as AgentAction from "../../src/AgentAction.ts"

const descriptor = new Descriptor.FlowDescriptor({
  name: "read",
  description: "Read one named value.",
  body: new Descriptor.BodyRefMarkdown({ path: "/flows/read/flow.md", baseDirectory: "/flows/read" }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("test:model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: true,
  path: "/flows/read",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})
// Promise.all queues both requests; Sandbox.driveCell delivers them serially.
export const queuedCell =
  `const values = await Promise.all([ctx.call("read", { args: "left" }), ctx.call("read", { args: "right" })]); console.log(values.join("+"))`
export const host = (perform: (text: string) => Effect.Effect<void>, value?: string): Partial<AgentAction.Host> => ({
  registry: Registry.makeNoop({
    visible: () => Effect.succeed([descriptor]),
    getOption: () => Effect.succeed(Option.some(descriptor)),
    runPrompt: (_name, input) => Effect.succeed(String(input.args))
  }),
  promptRunner: ({ text }) =>
    perform(text).pipe(Effect.as(new Cell.CallResult({ outcome: "success", value: value ?? text })))
})
