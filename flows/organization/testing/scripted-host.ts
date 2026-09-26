/**
 * An organization host whose seats answer from a script instead of a model,
 * for the offline end-to-end test (`flows/test/organization-host.test.mjs`).
 *
 * Everything else is the production host: the same settings, the durable
 * engine, the gateway, real microVM workspaces. Each seat recognises the
 * principal it is serving by the `# Role: <name> (<id>)` line of its system
 * prompt, looks up that principal's part, fills every output field its
 * charter declares, and answers with one cell: the router hands the request
 * to the contract writer, the contract writer names the builder and the
 * checker, the builder adds a line to `README.md` with the `edit` tool in
 * its workspace machine (a compensable step, as a model's edit is), and the
 * checker approves.
 *
 * The parts are the public example roster's (`assistant` routes to `lead`,
 * which contracts `builder` and `checker`) unless
 * `SMITHERS_ORGANIZATION_SCRIPTED_ROLES` names others, as JSON from principal
 * id to `route:<to>`, `contract:<builder>,<checker>`, `build`, or `check`, so
 * the same script drives any roster.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_HOLD=<file>` set and that file
 * present, the builder takes two turns: the first appends to `README.md`
 * with `bash` and does not answer, and the second writes `<file>.held` and never settles, so a
 * test can stop the host in the middle of the builder's turn, after its edit.
 * Without the file the second turn answers.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_REFUSE=1` every model call fails the
 * way a provider refuses an account with no credits.
 *
 * `SMITHERS_ORGANIZATION_SCRIPTED_OMIT`, as JSON from principal id to
 * `{ field, asks }`, makes that principal leave `field` out of its first
 * `asks` answers to a task (1: only the first ask; 2: the correction too),
 * the way a model forgets a charter field.
 *
 * `node flows/organization/testing/scripted-host.ts serve --standalone ...`
 * takes `serve`'s flags.
 */
import { NodeRuntime } from "@effect/platform-node"
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Effect, Stream } from "effect"
import { existsSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { platform } from "../../../packages/smithers/src/internal/NodeControlHost.ts"
import { start } from "../serve.ts"
import { environmentOf, resolve } from "../settings.ts"

/** The line the scripted builder appends. */
export const scriptedLine = "hello from the organization"

const done = (fields: Record<string, string>, summary: string, handoffs: ReadonlyArray<unknown> = []) => ({
  status: "done",
  summary,
  fields,
  evidence: [{ kind: "note", ref: "scripted", detail: "scripted answer" }],
  handoffs,
  escalations: [],
  decisions: []
})

const answering = (result: unknown) => `ctx.done(${JSON.stringify(JSON.stringify(result))})`

const hold = process.env.SMITHERS_ORGANIZATION_SCRIPTED_HOLD
const appendLine = `ctx.call("bash", { command: "printf '${scriptedLine}\\\\n' >> /workspace/README.md && tail -n 1 /workspace/README.md" })`

/** One principal's part in the script. */
type Part =
  | { readonly kind: "route"; readonly to: string }
  | { readonly kind: "contract"; readonly builder: string; readonly checker: string }
  | { readonly kind: "build" }
  | { readonly kind: "check" }

const partOf = (spec: string): Part => {
  const [kind = "", rest = ""] = spec.split(":")
  if (kind === "route" && rest !== "") return { kind, to: rest }
  const [builder = "", checker = ""] = rest.split(",")
  if (kind === "contract" && builder !== "" && checker !== "") return { kind, builder, checker }
  if (kind === "build" || kind === "check") return { kind }
  throw new Error(`SMITHERS_ORGANIZATION_SCRIPTED_ROLES: ${spec} is not a part`)
}

const exampleParts = { assistant: "route:lead", lead: "contract:builder,checker", builder: "build", checker: "check" }
const parts = new Map(
  Object.entries(
    JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_ROLES ?? JSON.stringify(exampleParts)) as Record<string, string>
  ).map(([principal, spec]) => [principal, partOf(spec)])
)

/** The principal a system prompt serves. */
const principalOf = (system: string) => /^# Role: .* \(([^()\s]+)\)$/m.exec(system)?.[1]

/** The output fields the charter in a system prompt declares. */
const fieldsOf = (system: string): ReadonlyArray<string> => {
  const section = /^## Output fields\n\n((?:- .*\n?)+)/m.exec(system)?.[1] ?? ""
  return section.split("\n").filter((entry) => entry.startsWith("- ")).map((entry) => entry.slice(2).split(": ")[0]!)
}

const omissions = new Map(
  Object.entries(
    JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_OMIT ?? "{}") as Record<string, { field: string; asks: number }>
  )
)

/** Which ask of its task the current model call answers: 1, or 2 once the host has sent a correction. */
let ask = 1

/** Every declared field, each saying `value`, less a field the principal is scripted to omit on this ask. */
const filled = (system: string, value: string) => {
  const omission = omissions.get(principalOf(system) ?? "")
  const omitted = omission !== undefined && ask <= omission.asks ? omission.field : undefined
  return Object.fromEntries(fieldsOf(system).filter((name) => name !== omitted).map((name) => [name, value]))
}

/** The builder's two turns when a hold is configured; `undefined` when the turn never settles. */
const heldBuilder = (system: string, turn: number, holdFile: string): string | undefined => {
  if (turn === 0) return `await ${appendLine};`
  if (existsSync(holdFile)) {
    writeFileSync(`${holdFile}.held`, "")
    return undefined
  }
  return answering(done(filled(system, "README.md now ends with the line."), "Appended the line to README.md."))
}

/** The one cell each principal answers with, by its part. */
const cellFor = (system: string, turn: number): string | undefined => {
  const principal = principalOf(system)
  const part = principal === undefined ? undefined : parts.get(principal)
  switch (part?.kind) {
    case "route":
      return answering(done(
        filled(system, `Routing to ${part.to}.`),
        `The request needs a change; ${part.to} owns it.`,
        [{ to: part.to, objective: "Deliver the owner's request.", inputs: ["The owner's request."] }]
      ))
    case "contract":
      return answering(done(
        filled(system, `README.md ends with the line '${scriptedLine}'.`),
        "One line appended to README.md, checked independently.",
        [
          {
            to: part.builder,
            objective: `Append the line '${scriptedLine}' to README.md.`,
            inputs: [`README.md ends with the line '${scriptedLine}'.`]
          },
          { to: part.checker, objective: "Check the README change against its criterion.", inputs: [] }
        ]
      ))
    case "build": {
      if (hold !== undefined) return heldBuilder(system, turn, hold)
      const result = done(filled(system, `README.md now ends with the line '${scriptedLine}'.`), "Added the line to README.md.")
      // A correction only restates the answer: the edit is already in the workspace.
      if (ask > 1) return answering(result)
      return `await ctx.call("edit", ${JSON.stringify({ path: "/workspace/README.md", oldString: "# Demo\n", newString: `# Demo\n${scriptedLine}\n` })});
ctx.done(${JSON.stringify(JSON.stringify(result))})`
    }
    case "check":
      return answering(done(filled(system, "approve"), "The README change meets its criterion."))
    default:
      return answering({
        status: "declined",
        summary: "The scripted seat does not serve this role.",
        fields: {},
        evidence: [],
        handoffs: [],
        escalations: [],
        decisions: []
      })
  }
}

const prepared: Route.PreparedRequest = {
  routeId: "organization/scripted",
  protocolId: "organization/scripted-v1",
  method: "POST",
  url: "http://127.0.0.1/organization/scripted",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** What a provider says when the account has no credits. */
export const refusal = "Your credit balance is too low to access the API."

const refuses = process.env.SMITHERS_ORGANIZATION_SCRIPTED_REFUSE === "1"

let cells = 0
const model = Model.make({
  stream: (request) =>
    Stream.suspend(() => {
      if (refuses) {
        return Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", message: refusal, httpStatus: 400 }))
      }
      const id = `cell-${++cells}`
      const turn = request.messages.filter((message) => message.role === "assistant").length
      const system = request.system.map((part) => part.text).join("\n")
      // The task and its context, a correction included, are in the system prompt.
      ask = system.includes("broke your charter") ? 2 : 1
      const text = cellFor(system, turn)
      if (text === undefined) return Stream.never
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + text + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    })
})

/** Every seat, answered by the script. */
export const seats = SeatResolver.make({
  resolve: (id) =>
    Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
})

const [command, ...argv] = process.argv.slice(2)
if (command !== "serve") throw new Error("usage: scripted-host.ts serve --standalone <serve flags>")
const { values } = parseArgs({
  args: argv,
  options: {
    standalone: { type: "boolean", default: false },
    root: { type: "string" },
    "state-dir": { type: "string" },
    repo: { type: "string", multiple: true },
    check: { type: "string", multiple: true },
    "max-rounds": { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    "env-file": { type: "string" }
  }
})
if (!values.standalone) throw new Error("the scripted host serves --standalone only")
const environment = environmentOf(values, process.env, process.cwd())
const settings = await resolve(values, environment, process.cwd())
NodeRuntime.runMain(await start({
  settings,
  environment,
  platform,
  seats,
  // A Slack fixture serves Socket Mode over plaintext on loopback.
  allowPlaintextSocket: environment.SMITHERS_ORGANIZATION_SLACK_FIXTURE === "1"
}))
