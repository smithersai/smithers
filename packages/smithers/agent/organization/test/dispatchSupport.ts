/**
 * A real agent composition for role-task dispatch tests.
 *
 * Everything under the role task is production — the durable memory engine,
 * the QuickJS cell sandbox, the cell controller, `AgentAction`, the
 * authority wrapper, and the role host — except the model, which answers
 * with scripted cells, and the `Agent` service, which is the real one
 * wrapped to write down what each run was given.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import { layer as scriptedJudge } from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Context, Effect, Exit, Layer, Option, Stream } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Authority from "../src/Authority.ts"
import type * as Profile from "../src/Profile.ts"
import type * as Prompt from "../src/Prompt.ts"
import * as RoleHost from "../src/RoleHost.ts"
import * as Roster from "../src/Roster.ts"
import * as Skills from "../src/Skills.ts"
import { examplePolicy, ok, run, tempDir } from "./support.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** What one model request carried: its system text and its messages. */
export interface Asked {
  readonly seat: string
  readonly text: string
}

/** A model answering with one scripted cell per request, recording each request. */
export const scripted = (cells: ReadonlyArray<string>, asked: Array<Asked>, seat = "any"): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        asked.push({
          seat,
          text: request.system.map((part) => part.text).join("\n") + "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        })
        const source = cells[index] ?? cells.at(-1)!
        index++
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

/** A cell completing with a role result. */
export const answering = (result: Profile.RoleResult): string => `ctx.done(${JSON.stringify(JSON.stringify(result))})`

/** A `done` result carrying `fields` and one note of evidence. */
export const done = (fields: Record<string, string>, summary = "Done."): Profile.RoleResult => ({
  status: "done",
  summary,
  fields,
  evidence: [{ kind: "note", ref: "scripted", detail: "scripted answer" }],
  handoffs: [],
  escalations: [],
  decisions: []
})

/** What the role host handed one agent run. */
export interface Recorded {
  readonly flows: ReadonlyArray<string>
  readonly envelope: ReadonlyArray<string>
  readonly system: ReadonlyArray<string>
  readonly skills: ReadonlyArray<string>
  readonly claimCap: number | undefined
  readonly serverTools: ReadonlyArray<unknown>
}

const recordingAgent = (recorded: Array<Recorded>) =>
  Layer.effect(Agent.Agent)(Effect.map(Agent.Agent, (agent) => ({
    run: (options: Agent.Options) =>
      Stream.unwrap(Effect.gen(function*() {
        const bindings = yield* Effect.forEach(options.flows ?? [], (source) => source.bindings()).pipe(
          Effect.orDie
        )
        const skills = yield* options.registry.visible()
        recorded.push({
          flows: bindings.flat().map((binding) => binding.descriptor.name).sort(),
          envelope: (options.capabilityEnvelope ?? []).map(Capability.format).sort(),
          system: options.system ?? [],
          skills: skills.map((descriptor) => descriptor.name),
          claimCap: options.claimCap,
          serverTools: options.serverTools ?? []
        })
        return agent.run(options)
      }))
  }))).pipe(Layer.provide(Agent.layer))

/** The composition's shared host, with a flow source a role must never inherit. */
export const baseHost: AgentAction.Host = {
  registry: Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none())
  }),
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 3,
  system: ["Host teaching."],
  flows: [{ name: "host-only", bindings: () => Effect.die(new Error("a role inherited the base host's flows")) }]
}

/** The noop memory store and recall a `memory` grant binds to. */
export const memoryServices = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
  Context.add(Recall.Recall, Recall.makeNoop())
)

/** The Node filesystem and path services, as a context. */
export const fileServices = Effect.runSync(
  Effect.context<FileSystem.FileSystem | Path.Path>().pipe(
    Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  )
)

/** The public example organization directory. */
export const exampleOrg = fileURLToPath(new URL("../example/Org/", import.meta.url))

/** A wiki root holding a copy of the example organization under `Org/`. */
export const wikiRoot = (): string => {
  const root = tempDir()
  mkdirSync(join(root, "Org"), { recursive: true })
  cpSync(exampleOrg, join(root, "Org"), { recursive: true })
  return root
}

export const common: Prompt.Common = { id: "common", version: "1", text: "Common operating instructions." }

/**
 * A roster directory's roster and skills, pinned: the public example by
 * default, or the test fixture organization (which has a hired specialist).
 */
export const loadSnapshot = async (
  edit: (profiles: Array<Profile.Profile>) => Array<Profile.Profile> = (p) => p,
  dir: string = exampleOrg
) => {
  const roster = await run(Roster.load(dir))
  const skills = await run(Skills.loadPack(join(dir, "Skills")))
  const edited = Roster.make(edit([...roster.profiles.values()]), roster.sources)
  return ok(Authority.makeSnapshot({ roster: edited, common, skills, weeklyMeeting: examplePolicy.weeklyMeeting }))
}

/** A profile with `patch` applied. */
export const patched = (profiles: Array<Profile.Profile>, id: string, patch: Partial<Profile.Profile>) =>
  profiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile)

/** A ready role-task payload for `principal`, composed from `snapshot`. */
export const payloadFor = (
  snapshot: Authority.Snapshot,
  principal: string,
  task: Profile.TaskContract,
  context: ReadonlyArray<Prompt.ContextEntry> = []
): Authority.RoleTaskPayload => {
  const profile = snapshot.roster.profiles.get(principal)!
  const composed = ok(Authority.compose(snapshot, profile, task, context))
  return { revision: snapshot.revision, principal, seat: profile.seat, task, context, digest: composed.digest }
}

export const task = (id = "task-1"): Profile.TaskContract => ({
  id,
  objective: "Make the small change.",
  inputs: ["The request."],
  acceptance: ["The change is made."],
  evidence: ["A note."],
  requestedBy: "lead"
})

/**
 * Everything under a role-task action layer: registry, resources, the base
 * host, scripted seats, the recording agent, safety decisions, the
 * implementation table, and the memory engine.
 */
export const agentStack = (options: {
  readonly snapshot: Authority.Snapshot
  readonly resources: RoleHost.Resources
  readonly model: Model.Model
  readonly recorded: Array<Recorded>
  /** Leave the shared host out of the composition's outputs. */
  readonly withoutHost?: boolean
}) =>
  Layer.mergeAll(
    Authority.layerRegistry(options.snapshot),
    RoleHost.layerResources(options.resources),
    options.withoutHost === true ? Layer.empty : AgentAction.layerHost(baseHost),
    SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({ id, modelId: Seat.modelIdOf(id), model: options.model, route, contextWindowTokens: 200_000 })
        )
    }),
    recordingAgent(options.recorded),
    Agent.layerDefaults,
    scriptedJudge
  ).pipe(
    Layer.provideMerge(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  )

/** The failure an exit carries, or the pretty cause when it is not one. */
export const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure, got a success")
  const found = Cause.findErrorOption(exit.cause)
  return Option.isSome(found) ? found.value : Cause.pretty(exit.cause)
}
