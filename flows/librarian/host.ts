/** Product workspace host. Its executable catalog is part of the deployed artifact. */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as NativeEquipment from "../../packages/smithers/src/internal/NativeEquipment.ts"
import { agentRuntime } from "./runtime.ts"
import { configured, roleResolver, type Options as SeatOptions } from "./seats.ts"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import wiki, { Wiki, registration as wikiRegistration, type WikiReceipt } from "./wiki/flow.ts"
import history, { History, registration as historyRegistration } from "./history/flow.ts"

export { roleResolver } from "./seats.ts"

export interface Options extends SeatOptions {
  readonly root: string
  readonly repo: string
  readonly gatewayId: string
  readonly credential: string
  readonly artifactDigest: string
  readonly sourceRevision: string
  readonly ownerGeneration: number
  readonly persistWiki: (receipt: WikiReceipt) => Promise<void | NonNullable<WikiReceipt["publishedPages"]>>
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/** Identity includes the entire compiled host, not just a declaration's prose. */
export const catalog = async (options: Options) => {
  const directory = join(options.root, ".flows", "product", options.artifactDigest)
  await mkdir(directory, { recursive: true })
  return Promise.all(([ ["wiki", wiki], ["history", history] ] as const).map(async ([kind, declaration]) => {
    const path = join(directory, `${kind}.json`)
    const source = JSON.stringify({ artifact: options.artifactDigest, flow: `librarian/${kind}` })
    try { await writeFile(path, source, { flag: "wx", mode: 0o444 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (await readFile(path, "utf8") !== source) throw new Error("Product flow identity was modified; refusing to serve")
    }
    const descriptor = new Descriptor.FlowDescriptor({
      name: `librarian/${kind}`, description: declaration.description ?? "", path,
      body: new Descriptor.BodyRefModule({ path, contentDigest: sha(source) }),
      input: new Descriptor.SchemaRefInline({ document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(declaration.input!))) }),
      output: new Descriptor.SchemaRefInline({ document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(declaration.output!))) }),
      model: Option.some(configured(options)), flows: Schema.decodeUnknownSync(Schema.Array(Schema.String))(declaration.flows), capabilities: declaration.capabilities,
      effects: Schema.decodeUnknownSync(Descriptor.EffectDeclaration)(declaration.effects), placement: Option.none(), modelInvocable: true, frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "product", root: directory })
    })
    return { descriptor, declaration }
  }))
}

export const layer = (platform: NativeControl.Platform, options: Options, suppliedSeats?: SeatResolver.Service) => {
  const model = configured(options)
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error("SMITHERS_REPO must identify the owning repository")
  if (!options.credential.trim() || !options.gatewayId.trim()) throw new Error("Product host requires its gateway identity and bearer credential")
  if (!/^[a-f0-9]{64}$/.test(options.artifactDigest)) throw new Error("Product host requires its immutable artifact digest")
  if (!/^[a-f0-9]{40}$/.test(options.sourceRevision) || !Number.isSafeInteger(options.ownerGeneration) || options.ownerGeneration <= 0) {
    throw new Error("Product host requires an immutable source revision and positive owner generation")
  }
  const native = NativeControl.make(platform, environment => Layer.effect(SeatResolver.SeatResolver)(
    Effect.map(SeatResolver.SeatResolver, base => roleResolver(base, model, options))
  ).pipe(Layer.provide(suppliedSeats === undefined ? NativeEquipment.layerSeatResolver(environment) : SeatResolver.layer(suppliedSeats))))
  return Layer.unwrap(Effect.promise(() => catalog(options)).pipe(Effect.map(entries => {
    const registry = Registry.layerFromDescriptors(entries.map(entry => entry.descriptor)).pipe(Layer.provide(platform.host))
    const modules = Executable.layer({ delegates: [Wiki, History], load: path => {
      const entry = entries.find(entry => entry.descriptor.path === path)
      return entry ? Effect.succeed({ default: entry.declaration }) : Effect.fail(new Error("Unknown product flow"))
    } }).pipe(
      Layer.provideMerge(wikiRegistration(options.root, options.persistWiki, options.repo)),
      Layer.provideMerge(historyRegistration(options.root, options.repo)),
      agentRuntime, Layer.provide(registry), Layer.orDie
    )
    const host = native.layerHost({ root: options.root, credential: options.credential,
      approvalAuthority: native.gatewayApprovalAuthority }, modules, registry)
    return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, gateway => ({
      launch: (health, bind, root) => gateway.launch({ ...health, gatewayId: options.gatewayId,
        runtimeBridge: { protocol: "smithers.flow-runtime/v1", runtimeArtifactDigest: options.artifactDigest,
          sourceRevision: options.sourceRevision, ownerGeneration: options.ownerGeneration },
        capabilities: ["librarian/v1", "flow-runtime-bridge/v1"] }, {
        ...bind,
        runtimeBridge: { runtimeArtifactDigest: options.artifactDigest, sourceRevision: options.sourceRevision,
          ownerGeneration: options.ownerGeneration }
      }, root)
    }))).pipe(Layer.provideMerge(host))
  })))
}
