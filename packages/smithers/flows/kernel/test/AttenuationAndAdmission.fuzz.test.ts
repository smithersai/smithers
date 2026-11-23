import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Context, Effect, Fiber, FileSystem, Layer, Logger, Option, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Request from "effect/http/HttpClientRequest"
import * as Command from "effect/process/ChildProcess"
import { ChildProcessSpawner as Spawner } from "effect/process/ChildProcessSpawner"
import { once } from "node:events"
import { rm } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CapabilitySet,
  ChildProcessSpawner,
  GrantStore,
  HostServices,
  HttpClient,
  Jj,
  ProcessConfinement,
  Workspace
} from "../src/index.ts"
import { makeWorkspace, rawHost } from "./fixtures/quickstartHost.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const pattern = (action: Capability.PatternAction, resource: string) =>
  new Capability.CapabilityPattern({ action, resource })
const allow = (action: Capability.PatternAction, resource: string) =>
  new Permission.Rule({ effect: "allow", pattern: pattern(action, resource) })
const mask = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
const masks = Arbitrary.schema(Schema.Struct({ outer: mask, inner: mask }))
const selected = (mask: number, index: number) => (mask & (1 << index)) !== 0
const group = (probes: ReadonlyArray<Capability.Capability>, mask: number) =>
  probes.filter((_, index) => selected(mask, index)).map((probe) => pattern(probe.action, probe.resource))
const passed = <A, E>(report: Fuzz.Report<A, E>) => expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
const outside = (probe: Capability.Capability) =>
  expect.objectContaining({ code: "permission_denied", reason: "outside capability ceiling", capability: probe })
const grantLayer = GrantStore.layer({ attended: false, rules: [allow("*", "**")] })

describe("capability attenuation (#4531)", () => {
  it("keeps nested store views bounded after scope exit and rejects unbranded ceiling data", async () => {
    const probes = ["north", "south", "east", "west"].map((name) => Capability.make("memory:read", name))
    const program = Fuzz.run(masks, ({ outer, inner }) =>
      Effect.gen(function*() {
        const store = yield* GrantStore.GrantStore
        const observe = Effect.gen(function*() {
          const ambient = yield* CapabilitySet.current
          const active = yield* Effect.setContext(CapabilitySet.current, Context.empty())
          const child = yield* Fiber.join(
            yield* Effect.forkChild(Effect.setContext(CapabilitySet.current, Context.empty()))
          )
          for (const ceiling of [ambient, active, child]) {
            for (const [i, probe] of probes.entries()) {
              expect(CapabilitySet.allows(ceiling, probe)).toBe(selected(outer & inner, i))
            }
          }
          return yield* GrantStore.GrantStore
        })
        const captured = yield* observe.pipe(
          CapabilitySet.attenuate(group(probes, inner)),
          CapabilitySet.attenuate(group(probes, outer))
        )
        const valid = CapabilitySet.fromPatterns(group(probes, inner))
        // A structural copy carries the same visible groups but no issuer identity.
        const copy = { ...valid }
        for (const view of [captured, GrantStore.attenuated(captured, valid)]) {
          const policy = yield* view.policy
          for (const [i, probe] of probes.entries()) {
            const expected = selected(outer & inner, i)
            expect(CapabilitySet.allows(policy.ceiling, probe)).toBe(expected)
            if (expected) yield* view.check(probe)
            else expect(yield* Effect.flip(view.check(probe))).toEqual(outside(probe))
          }
        }
        for (const untrusted of [copy, { ...CapabilitySet.fromGroups([]) }]) {
          const view = GrantStore.attenuated(store, untrusted)
          expect(CapabilitySet.equals((yield* view.policy).ceiling, CapabilitySet.none)).toBe(true)
          for (const probe of probes) {
            expect(yield* Effect.flip(view.check(probe))).toEqual(outside(probe))
            yield* store.check(probe)
          }
        }
        return true
      }), { seed, executions: pureExecutions, execution: FuzzSimulation.execution() })
    passed(
      await Effect.runPromise(
        program.pipe(
          Effect.provide(grantLayer),
          Effect.provide(Workspace.layer("/fixture")),
          Effect.provide(Logger.layer([]))
        )
      )
    )
  })

  it("preserves each host service ceiling in a detached fiber after both scopes exit", async () => {
    const root = makeWorkspace()
    try {
      const raw = Layer.mergeAll(
        rawHost(root),
        HttpClient.layerNoop(),
        Jj.layerNoop({}),
        ChildProcessSpawner.layerNoop(),
        ProcessConfinement.layerNoop
      )
      const guarded = HostServices.layer.pipe(Layer.provide(grantLayer), Layer.provide(raw))
      const probes = [
        Capability.make("fs:read", join(root, "README.md")),
        Capability.make("net:get", "assets.test"),
        Capability.make("proc:spawn", "render"),
        Capability.make("jj:status", ".")
      ]
      const tags = [FileSystem.FileSystem, HttpClient.HttpClient, Spawner, Jj.Jj] as const
      type Hosts = typeof tags[number]["Identifier"]
      const capture = Effect.contextWith((ctx: Context.Context<Hosts>) => Effect.succeed(Context.pick(...tags)(ctx)))
      const program = Fuzz.run(masks, ({ outer, inner }) =>
        Effect.gen(function*() {
          const captured = yield* capture.pipe(
            CapabilitySet.attenuate(group(probes, inner)),
            CapabilitySet.attenuate(group(probes, outer))
          )
          const allowed = outer & inner
          const check = Effect.gen(function*() {
            const file = (yield* FileSystem.FileSystem).readFileString("README.md")
            if (selected(allowed, 0)) {
              expect(yield* file).toBe("# hello")
            } else {
              const error = yield* Effect.flip(file)
              expect(Option.getOrThrow(Permission.fromPlatformError(error))).toEqual(outside(probes[0]!))
            }

            // These three raw host ports are unavailable. A host failure proves the
            // guard delegated; a ceiling denial must identify the exact operation.
            const http = yield* Effect.flip((yield* HttpClient.HttpClient).get("https://assets.test/page"))
            if (selected(allowed, 1)) expect(HttpClient.isUnavailable(http)).toBe(true)
            else expect(Option.getOrThrow(HttpClient.fromHttpClientError(http))).toEqual(outside(probes[1]!))

            const spawn = yield* Effect.flip(Effect.scoped((yield* Spawner).spawn(Command.make("render"))))
            if (selected(allowed, 2)) {
              expect(spawn.reason).toMatchObject({ _tag: "NotFound", module: "ChildProcessSpawner" })
            } else expect(Option.getOrThrow(Permission.fromPlatformError(spawn))).toEqual(outside(probes[2]!))

            const jj = yield* Effect.flip((yield* Jj.Jj).status())
            if (selected(allowed, 3)) {
              expect(jj).toMatchObject({ code: "not_installed" })
            } else expect(jj).toEqual(outside(probes[3]!))
          })
          yield* Fiber.join(yield* Effect.forkDetach(Effect.setContext(check, captured)))
          return true
        }), { seed, executions: ioExecutions })
      passed(await Effect.runPromise(program.pipe(Effect.provide(guarded), Effect.provide(Logger.layer([])))))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("model admission (#4655)", () => {
  it("binds the claim, endpoint, declared model and grant before a POST reaches transport", async () => {
    const received: string[] = []
    const server = createServer((req, res) => {
      received.push(req.url ?? "")
      req.resume()
      res.writeHead(204).end()
    })
    try {
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("expected loopback port")
      const origin = `http://127.0.0.1:${address.port}`
      const endpoint = origin + "/models"
      const guarded = HttpClient.layerWith({ modelIdentity: HttpClient.modelEndpoints([{ url: endpoint }]) }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
      const arb = Arbitrary.schema(Schema.Struct({
        id: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
        header: Schema.Literals(["ai-model-id", "x-model-id", "X-Model-Call"]),
        otherFirst: Schema.Boolean
      }))
      const program = Fuzz.run(arb, ({ id, header, otherFirst }) =>
        Effect.gen(function*() {
          const granted = `model-${id}`
          const other = granted + "-other"
          const store = yield* GrantStore.make({
            attended: false,
            rules: [allow("model:call", origin + "/" + granted)]
          })
          const client = yield* HttpClient.HttpClient.pipe(
            Effect.provide(guarded),
            Effect.provideService(GrantStore.GrantStore, store)
          )
          const before = received.length
          for (const body of otherFirst ? [other, granted] : [granted, other]) {
            for (const claim of [undefined, granted, other]) {
              for (const url of [endpoint, origin + "/other"]) {
                const request = Request.post(url, { headers: { [header]: granted } }).pipe(
                  Request.bodyJsonUnsafe({
                    model: body,
                    modelId: granted,
                    metadata: { model: granted, admitted: true }
                  })
                )
                const annotated = Object.assign(request, { modelId: granted, modelCall: true })
                const send = client.execute(annotated).pipe(Effect.provideService(HttpClient.ModelCall, granted))
                const response = yield* Effect.result(
                  claim === undefined ? send : send.pipe(HttpClient.withModelCall(claim))
                )
                const admittedModel = url === endpoint && claim === body
                if (admittedModel && body === granted) {
                  expect(response).toMatchObject({ _tag: "Success", success: { status: 204 } })
                } else {
                  if (response._tag !== "Failure") throw new Error("unexpected admitted POST")
                  expect(Option.getOrThrow(HttpClient.fromHttpClientError(response.failure))).toMatchObject({
                    capability: admittedModel
                      ? { action: "model:call", resource: origin + "/" + body }
                      : { action: "net:post", resource: origin }
                  })
                }
              }
            }
          }
          expect(received.slice(before)).toEqual(["/models"])
          return true
        }).pipe(Effect.scoped), { seed, executions: ioExecutions })
      passed(
        await Effect.runPromise(
          program.pipe(Effect.provide(Workspace.layer("/fixture")), Effect.provide(Logger.layer([])))
        )
      )
    } finally {
      if (server.listening) {
        const closed = once(server, "close")
        server.close()
        server.closeAllConnections()
        await closed
      }
    }
  })
})
