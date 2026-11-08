/**
 * The Smithers plugin through the real kernel, catalog, and call resolver.
 *
 * Each case goes through the path a cell uses: the kernel resolves the plugin,
 * `cellFlows` composes the catalog, and `CellCalls` answers `ctx.call`.
 */
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Result, type Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CellPlugin from "../src/CellPlugin.ts"
import * as SmithersPlugin from "../src/SmithersPlugin.ts"

const callOf = (descriptor: FlowBinding.Binding["descriptor"], input: Schema.Json): Cell.Call =>
  new Cell.Call({
    flowName: descriptor.name,
    input,
    capabilities: descriptor.capabilities,
    effects: descriptor.effects,
    placement: descriptor.placement,
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: Cell.declarationDigest(descriptor),
      layers: []
    })
  })

const compose = (plugin: ReturnType<typeof SmithersPlugin.make>, existing: ReadonlyArray<FlowBinding.Binding> = []) =>
  Effect.gen(function*() {
    const kernel = yield* CellPlugin.make([plugin])
    return yield* CellPlugin.flows(kernel.plugins, existing)
  })

const call = async (
  bindings: ReadonlyArray<FlowBinding.Binding>,
  name: string,
  input: Schema.Json,
  failures: Array<Cell.FailureKind> = []
) => {
  const catalog = Result.getOrThrow(FlowBinding.catalogResult(bindings))
  const binding = bindings.find((each) => each.descriptor.name === name)!
  return Effect.runPromise(
    CellCalls.make({ registry: FlowBinding.registry(Registry.makeNoop({}), catalog), catalog })
      .run(callOf(binding.descriptor, input))
      .pipe(
        Effect.provideService(Cell.Failures, (kind) =>
          Effect.sync(() => {
            failures.push(kind)
          })),
        Effect.orDie
      )
  )
}

describe("SmithersPlugin", () => {
  it("contributes only smithers.guide without host ports", async () => {
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make()))
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["smithers.guide"])
  })

  it("answers smithers.guide by topic from the structured knowledge", async () => {
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make()))
    const cli = await call(bindings, "smithers.guide", { topic: "cli" })
    expect(cli).toMatchObject({ outcome: "success", value: { cli: SmithersPlugin.knowledge.cli } })
    expect(Object.keys((cli as { value: object }).value)).toEqual(["cli"])
    const all = await call(bindings, "smithers.guide", {})
    expect(Object.keys((all as { value: object }).value)).toEqual(["packages", "cli", "authoring"])
    expect(await call(bindings, "smithers.guide", { topic: "nope" })).toMatchObject({ outcome: "failure" })
  })

  it("lists, runs, and inspects through the host ports and returns plain JSON", async () => {
    const seen: Array<unknown> = []
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make({
      list: () => [{ name: "review", description: "Review a change." }],
      run: (request) => (seen.push(request), { id: request.id, status: "requested" }),
      inspect: async (id) => ({ id, status: "running", answer: undefined })
    })))
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "smithers.guide",
      "smithers.flows",
      "smithers.run",
      "smithers.inspect"
    ])
    expect(await call(bindings, "smithers.flows", {})).toMatchObject({
      outcome: "success",
      value: [{ name: "review", description: "Review a change." }]
    })
    expect(await call(bindings, "smithers.run", { id: "r1", flow: "review", input: { change: "abc" } })).toMatchObject({
      outcome: "success",
      value: { id: "r1", status: "requested" }
    })
    expect(seen).toEqual([{ id: "r1", flow: "review", input: { change: "abc" } }])
    const inspected = await call(bindings, "smithers.inspect", { id: "r1" })
    expect(inspected).toMatchObject({ outcome: "success", value: { id: "r1", status: "running" } })
    expect("answer" in (inspected as { value: object }).value).toBe(false)
  })

  it("preserves the receiver of a stateful list port", async () => {
    class ProjectPorts implements SmithersPlugin.Ports {
      readonly projectFlows = [{ name: "review", description: "Review a change." }]
      list() {
        return this.projectFlows
      }
      run(request: Parameters<SmithersPlugin.Ports["run"]>[0]) {
        return { id: request.id, status: "requested" }
      }
      inspect(id: string) {
        return { id, status: "running" }
      }
    }
    const ports = new ProjectPorts()
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make(ports)))
    expect(await call(bindings, "smithers.flows", {})).toMatchObject({
      outcome: "success",
      value: ports.projectFlows
    })
  })

  it.each(["throw error", "throw string", "reject error", "reject string", "serialization"])(
    "keeps arbitrary host exception details opaque: %s",
    async (failure) => {
      const secret = "Authorization: Bearer private-host-credential https://user:password@internal.invalid"
      const faultyPort = () => {
        if (failure === "throw error") throw new Error(secret)
        if (failure === "throw string") throw secret
        if (failure === "reject error") return Promise.reject(new Error(secret))
        if (failure === "reject string") return Promise.reject(secret)
        return {
          toJSON: () => {
            throw new Error(secret)
          }
        }
      }
      const bindings = await Effect.runPromise(compose(SmithersPlugin.make({
        list: faultyPort,
        run: faultyPort,
        inspect: faultyPort
      })))
      for (
        const [name, input] of [
          ["smithers.flows", {}],
          ["smithers.run", { id: "r1", flow: "review" }],
          ["smithers.inspect", { id: "r1" }]
        ] as const
      ) {
        const failures: Array<Cell.FailureKind> = []
        const result = await call(bindings, name, input, failures)
        expect(result).toMatchObject({ outcome: "failure", message: `Flow ${name} failed.` })
        expect(JSON.stringify(result)).not.toContain(secret)
        expect(failures).toEqual([{}])
        expect(JSON.stringify(failures)).not.toContain(secret)
      }
    }
  )

  it("returns an opaque failure for a refused host port", async () => {
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make({
      list: () => [],
      run: () => {
        throw new Error("Three flow runs are active; wait for a completion")
      },
      inspect: () => {
        throw new Error("Unknown tab")
      }
    })))
    expect(await call(bindings, "smithers.run", { id: "r1", flow: "review" })).toMatchObject({
      outcome: "failure",
      message: "Flow smithers.run failed."
    })
  })

  it("answers null for a missing value and keeps a rejected string opaque", async () => {
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make({
      list: () => undefined,
      run: () => ({}),
      inspect: () => Promise.reject("Unknown run")
    })))
    expect(await call(bindings, "smithers.flows", {})).toMatchObject({ outcome: "success", value: null })
    expect(await call(bindings, "smithers.inspect", { id: "gone" })).toMatchObject({
      outcome: "failure",
      message: "Flow smithers.inspect failed."
    })
  })

  it("fails catalog assembly instead of shadowing an existing name", async () => {
    const bindings = await Effect.runPromise(compose(SmithersPlugin.make(), [SmithersPlugin.guide]))
    expect(Result.isFailure(FlowBinding.catalogResult(bindings))).toBe(true)
  })

  it("appends the brief to a model request once", async () => {
    const kernel = await Effect.runPromise(CellPlugin.make([SmithersPlugin.make()]))
    const request = ModelRequest.ModelRequest.make({
      modelId: "test:model",
      system: [ModelRequest.SystemPart.make({ text: "host" })],
      messages: [],
      tools: [],
      toolChoice: "none",
      params: ModelRequest.GenerationParams.make({})
    })
    const once = await Effect.runPromise(CellPlugin.modelRequest(kernel.plugins, request))
    const twice = await Effect.runPromise(CellPlugin.modelRequest(kernel.plugins, once))
    expect(once.system.map((part) => part.text)).toEqual(["host", SmithersPlugin.brief])
    expect(twice.system.map((part) => part.text)).toEqual(["host", SmithersPlugin.brief])
  })

  it("names every CLI verb it teaches in the brief", () => {
    for (const verb of ["flow", "runs", "generate", "test", "docs", "tui"]) {
      expect(SmithersPlugin.knowledge.cli.some((fact) => fact.name.startsWith(`smthrs ${verb}`))).toBe(true)
      expect(SmithersPlugin.brief).toContain(verb)
    }
  })

  it("teaches flows at .smithers/flows/<name>/ and never the retired root flows/", () => {
    const taught = [SmithersPlugin.brief, ...Object.values(SmithersPlugin.knowledge).flat().map((fact) => fact.about)]
    expect(SmithersPlugin.brief).toContain(".smithers/flows/<name>/flow.ts")
    for (const text of taught) expect(text).not.toMatch(/(^|[\s(`])flows\/<name>/)
  })

  it("never names a version control system: the host says which one the repository uses", () => {
    const taught = [SmithersPlugin.brief, ...Object.values(SmithersPlugin.knowledge).flat().map((fact) => fact.about)]
    for (const text of taught) expect(text).not.toMatch(/\b(jj|git)\b/)
  })
})
