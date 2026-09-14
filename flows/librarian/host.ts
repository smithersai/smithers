/** Product workspace host. Its executable catalog is part of the deployed artifact. */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import wiki, { Wiki, registration as wikiRegistration, type WikiReceipt } from "./wiki/flow.ts"
import history, { History, registration as historyRegistration } from "./history/flow.ts"

export interface Options {
  readonly root: string
  readonly repo: string
  readonly gatewayId: string
  readonly credential: string
  readonly artifactDigest: string
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
      model: Option.none(), flows: Schema.decodeUnknownSync(Schema.Array(Schema.String))(declaration.flows), capabilities: declaration.capabilities,
      effects: Schema.decodeUnknownSync(Descriptor.EffectDeclaration)(declaration.effects), placement: Option.none(), modelInvocable: true, frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "product", root: directory })
    })
    return { descriptor, declaration }
  }))
}

export const layer = (platform: NativeControl.Platform, options: Options) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error("SMITHERS_REPO must identify the owning repository")
  if (!options.credential.trim() || !options.gatewayId.trim()) throw new Error("Product host requires its gateway identity and bearer credential")
  if (!/^[a-f0-9]{64}$/.test(options.artifactDigest)) throw new Error("Product host requires its immutable artifact digest")
  const native = NativeControl.make(platform)
  return Layer.unwrap(Effect.promise(() => catalog(options)).pipe(Effect.map(entries => {
    const registry = Registry.layerFromDescriptors(entries.map(entry => entry.descriptor)).pipe(Layer.provide(platform.host))
    const modules = Executable.layer({ delegates: [Wiki, History], load: path => {
      const entry = entries.find(entry => entry.descriptor.path === path)
      return entry ? Effect.succeed({ default: entry.declaration }) : Effect.fail(new Error("Unknown product flow"))
    } }).pipe(
      Layer.provideMerge(wikiRegistration(options.root, options.persistWiki, options.repo)),
      Layer.provideMerge(historyRegistration(options.root, options.repo)),
      Layer.provide(registry), Layer.orDie
    )
    const host = native.layerHost({ root: options.root, credential: options.credential,
      approvalAuthority: native.gatewayApprovalAuthority }, modules, registry)
    return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, gateway => ({
      launch: (health, bind, root) => gateway.launch({ ...health, gatewayId: options.gatewayId,
        capabilities: ["librarian/v1"] }, bind, root)
    }))).pipe(Layer.provideMerge(host))
  })))
}
