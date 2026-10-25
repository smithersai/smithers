// The Worker worker/AgentSandbox.workerd.test.ts runs in local workerd (Miniflare), bundled the way Alchemy bundles
// ChatApi: one cell the `todo` run's agent writes, evaluated in the agent's sandbox on Cloudflare (worker/AgentSandbox.ts)
// with the run's own sandbox tools (worker/flows/TodoAgent.ts `machineBindings`) over an in-memory checkout. Only the
// machine differs from production: on Cloudflare it is the branch's container.
//
// This file is the program boundary: it runs Effects with `Effect.runPromise`.
import { FlowRuntime } from "@smthrs/flow"
import { Cell, Sandbox } from "@smthrs/harness"
import { SandboxTools } from "@smthrs/sandbox"
import { Effect, Option } from "effect"
import * as AgentSandbox from "../../AgentSandbox.ts"
import { COMMAND_LIMIT_SECONDS } from "../../../src/features/sandbox/contract.ts"
import { Machines } from "../../branch/Machines.ts"
import { noCommands } from "../commands.ts"
import * as TodoAgent from "../../flows/TodoAgent.ts"
import * as TodoMachine from "../../flows/TodoMachine.ts"

const ATTEMPT = "6f0e2b9c-1d4a-4c3b-9e8f-7a6b5c4d3e2f"

const MACHINE = TodoMachine.machineOf({
  attemptId: ATTEMPT,
  repoId: "github/octo/hello",
  checkout: "0f".repeat(20),
  ownerId: "maya",
})

/** The cell: what the agent writes to read the checkout and change one file. */
const CELL = `const listing: { entries: Array<{ name: string }> } = await ctx.call("sandbox/list", {})
const readme = await ctx.call("sandbox/read", { path: "README.md" })
await ctx.call("sandbox/write", { path: "README.md", content: readme.content + "Hello from T1.\\n" })
ctx.done(listing.entries.map((entry) => entry.name).join(","))`

/** The checkout, in memory, and the calls the machine ran. */
const checkout = () => {
  const files = new Map<string, string>([["README.md", "# hello\n"]])
  const calls: Array<string> = []
  const result = (call: SandboxTools.Call): SandboxTools.Result => {
    switch (call.tool) {
      case "list":
        return {
          tool: "list",
          path: ".",
          entries: [...files].map(([name, content]) => ({ name, kind: "file" as const, bytes: content.length })),
          truncated: false,
        }
      case "read":
        return { tool: "read", path: call.path, content: files.get(call.path) ?? "", bytes: 0, truncated: false }
      case "write":
        files.set(call.path, call.content)
        return { tool: "write", path: call.path, bytes: call.content.length }
      default:
        throw new Error(`the cell never calls ${call.tool}`)
    }
  }
  const machines = Machines.of({
    commands: () => noCommands,
    tool: (branch, ownerId, _callId, call) =>
      Effect.sync(() => {
        calls.push(`${branch.branch} ${ownerId} ${call.tool}`)
        return { result: result(call), generation: 1 }
      }),
    sleepIfIdle: () => Effect.die("the tools never put a machine to sleep"),
  })
  return { files, calls, machines }
}

/** Runs `CELL` in the agent's sandbox: its outcome, the machine's calls and the checkout's files after. */
const runCell = Effect.gen(function* () {
  const { files, calls, machines } = checkout()
  const bindings = TodoAgent.machineBindings(machines, () => Effect.succeed(Option.some(MACHINE)), COMMAND_LIMIT_SECONDS)
  const flows = Object.fromEntries(bindings.map((binding) => [binding.descriptor.name, Cell.project(binding.descriptor)]))
  const run = { executionId: `todo:${ATTEMPT}` } as unknown as FlowRuntime.FlowInstance["Service"]
  // The harness's boundary in miniature: each call of the cell runs its tool's binding inside the attempt's run.
  const call: Sandbox.Handler = (invocation) =>
    bindings.find((binding) => binding.descriptor.name === invocation.flow)!.run(
      new Cell.Call({
        flowName: invocation.flow,
        input: invocation.input,
        capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none(),
        identity: new Cell.CallIdentity({
          session: "s",
          frame: 0,
          cell: "c",
          ordinal: invocation.ordinal,
          declaration: "d",
          layers: [],
        }),
      }),
    ).pipe(Effect.provideService(FlowRuntime.FlowInstance, run))
  const sandbox = yield* Sandbox.Sandbox
  const realm = yield* sandbox.openRealm!({ flows })
  const frame = yield* realm.evaluate({ cell: Cell.source(CELL, "typescript"), frame: 0, call })
  return { outcome: frame.outcome, calls, files: Object.fromEntries(files) }
}).pipe(Effect.scoped, Effect.provide(AgentSandbox.layer))

export default {
  fetch: (): Promise<Response> =>
    Effect.runPromise(
      runCell.pipe(
        Effect.map((ran) => Response.json(ran)),
        Effect.catchCause((cause) => Effect.succeed(new Response(String(cause), { status: 500 }))),
      ),
    ),
}
