/** Build-only observation of the shipped native and configured coding hosts.
 * No flow body, customer module, model request or outbound action is executed.
 * Native receipt/landing and evaluator ports are fixtures: this is registry
 * evidence, not installed-host or guest-execution acceptance.
 */
import * as NodeControl from "@smthrs/cli/NodeControl"
import { FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, type Scope } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Host from "../../coding/host.ts"
import { Landing } from "../../coding/landing.ts"
import { makeHostJudge } from "./scripted-judge.ts"
import { systemFlows } from "./system-flows.ts"

const repository = fileURLToPath(new URL("../../../../", import.meta.url))

/** One flow registration a built host made, with the file that declared it. */
export interface RuntimeTag {
  readonly id: string
  readonly runtime: "install" | "machine"
  readonly kind: "registration"
  readonly source?: string
}

export interface RegistryInventory {
  readonly host: "native" | "coding" | "coding-wiki"
  readonly tags: readonly RuntimeTag[]
}

/** Actual runtime registrations, including the private layers absent from the
 * public repository catalog. A source is observed from existing provenance;
 * runtime placement comes from the built host.
 */
export const withProductionRegistries = async <A>(
  inspect: (inventories: readonly RegistryInventory[], runtimes: readonly FlowRuntime.FlowRuntime["Service"][]) => Effect.Effect<A, never, Scope.Scope>,
  extraRegistrations?: Layer.Layer<never, never, FlowRuntime.FlowRuntime>,
  installed = true
): Promise<A> => {
  const artifactRoot = resolve(repository, ".artifacts")
  await mkdir(artifactRoot, { recursive: true })
  const temporary = await mkdtemp(resolve(artifactRoot, "catalog-registry-"))
  const repositoryPath = resolve(temporary, "repo")
  await mkdir(resolve(repositoryPath, ".smithers", "flows"), { recursive: true })
  const helperPath = resolve(temporary, "native-read")
  const operationId = "a".repeat(128)
  const head = { kind: "resolved", changeId: "z".repeat(32), commitId: "b".repeat(40), treeId: "c".repeat(40), operationId, parentCommitIds: [] }
  const receipt = JSON.stringify({ status: "read", operationId, head, revisions: [head], capabilities: ["apply-files/v1"] })
  // Only construction's native read is supported; mutations fail closed.
  await writeFile(helperPath, `#!/usr/bin/env node\nlet input="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{if(JSON.parse(input).operation!=="read")process.exit(1);process.stdout.write(${JSON.stringify(receipt)})});\n`, { mode: 0o700 })
  const inventories: RegistryInventory[] = []
  const runtimes: FlowRuntime.FlowRuntime["Service"][] = []
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      for (const host of ["native", "coding", "coding-wiki"] as const) {
        const tags: RuntimeTag[] = []
        const observer = Layer.effectDiscard(Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          runtimes.push(runtime)
          const original = runtime.register
          const descriptor = Object.getOwnPropertyDescriptor(runtime, "register")!
          const observed: typeof runtime.register = (flow, handler, options) => {
            const site = Object.getOwnPropertyDescriptor(flow, "~@smthrs/flow/DeclaredAt")?.value as { readonly path?: string } | undefined
            tags.push({ id: flow._tag, runtime: "machine", kind: "registration", ...(site?.path === undefined ? {} : { source: relative(repository, site.path) }) })
            return original(flow, handler, options)
          }
          Object.defineProperty(runtime, "register", { ...descriptor, value: observed })
          yield* Effect.addFinalizer(() => Effect.sync(() => { Object.defineProperty(runtime, "register", descriptor) }))
        }))
        const observedPlatform: NodeControl.Platform = {
          ...NodeControl.platform, evaluator: makeHostJudge().layer,
          runtime: (options, boundary, sandbox, registrations, ...registry) =>
            NodeControl.platform.runtime(options, boundary, sandbox, registrations.pipe(Layer.provideMerge(observer)), ...registry)
        }
        const stateRoot = resolve(temporary, `${host}-state`)
        const layer = host === "native"
          ? NodeControl.make(observedPlatform).layerHost({ root: repositoryPath, stateRoot, credential: "registry-fixture" }, extraRegistrations as NodeControl.ModuleRegistration | undefined)
          : Host.layer(observedPlatform, {
            repositoryPath, stateRoot, helperPath, installed, sourcePublication: "local-only", systemFlows,
            gatewayId: "11111111-1111-4111-8111-111111111111", credential: "registry-fixture", implementationModel: "openai:gpt-6-luna",
            planning: host === "coding-wiki"
              ? { wiki: true, implementation: "coding/implementation", wikiOutput: resolve(temporary, "wiki"), reviewer: "catalog-registry", pages: [{ id: "overview", title: "Overview", purpose: "Registry fixture", document: "overview.md", inputs: [], kind: "current", related: [] }], checks: [] }
              : { wiki: false, implementation: "coding/implementation", pages: [], checks: [] }, landing: Layer.succeed(Landing, {} as never)
          })
        yield* Layer.build(layer)
        inventories.push({ host, tags: [...tags] })
      }
      return yield* inspect(inventories, runtimes)
    })))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventories = await withProductionRegistries(inventories => Effect.succeed(inventories))
  process.stdout.write(`${JSON.stringify(inventories, null, 2)}\n`)
}
