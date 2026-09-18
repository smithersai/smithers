/** Bundled declarations are available before a repository has written any flows. */
import * as Digest from "@smthrs/core/Digest"
import * as CoreFlow from "@smthrs/core/Flow"
import * as Executable from "@smthrs/registry/Executable"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as Discovery from "@smthrs/registry/Discovery"
import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow"
import { registryError } from "@smthrs/registry/RegistryError"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { deploymentMinutes, deploymentTokens } from "./inspection.ts"
import { JobInput, JobResult, OperationResult, SetupInput, TriggerRequest } from "./schema.ts"
import { TriggerOutcome } from "./triggers.ts"

declare const __SMITHERS_CODING_ARTIFACT_DIGEST__: string | undefined
const policySources = ["schema.ts", "remote.ts", "inspection.ts", "jobs.ts", "execution.ts", "events.ts", "intake.ts", "retention.ts", "evaluation.ts", "setup.ts", "registry.ts", "receipts.ts", "activation.ts", "source.ts", "checks.ts", "check-context.ts", "changes.ts", "replies.ts", "delivery.ts", "ci-policy.ts", "check-receipt.ts", "triggers.ts",
  "../coding/host.ts", "../coding/native.ts", "../coding/native-schema.ts", "../coding/schema.ts", "../coding/dispatch.ts", "../coding/planning-authority.ts", "../coding/immutable-source.ts", "../../packages/rpc/src/RepositorySetup.ts", "../../pnpm-lock.yaml"]
export const runningRepositoryPolicy = Effect.gen(function*() {
  if (typeof __SMITHERS_CODING_ARTIFACT_DIGEST__ !== "undefined") {
    if (!/^[0-9a-f]{64}$/.test(__SMITHERS_CODING_ARTIFACT_DIGEST__)) return yield* Effect.fail(new Error("Invalid repository host fingerprint"))
    return __SMITHERS_CODING_ARTIFACT_DIGEST__
  }
  const fs = yield* FileSystem.FileSystem
  const sources = yield* Effect.forEach(policySources, name => Effect.gen(function*() {
    const path = fileURLToPath(new URL(name, import.meta.url)), stat = yield* fs.stat(path)
    if (stat.size > 2_000_000n) return yield* Effect.fail(new Error("Repository policy source exceeds its bound"))
    return { name, digest: Digest.digest(yield* fs.readFileString(path)) }
  }))
  return Digest.digest(Digest.canonical(sources))
})
export const provisionBuiltins = (stateRoot: string, policy: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
  const root = path.join(stateRoot, "builtin-flows", policy)
  const entries = [
    { name: "repository/setup", delegate: "repository/RunSetup", description: "Configure, evaluate and activate one repository responsibility." },
    { name: "repository/trigger", delegate: "repository/RunTrigger", description: "Register one repository flow to run on a reviewed schedule." },
    ...(["issues", "review", "ci", "feature", "chores"] as const).map(job => ({ name: `repository-jobs/${job}`,
      delegate: "repository/RunJob", description: `Run the reviewed ${job} responsibility with recorded evidence.` })),
    { name: "coding", delegate: "coding/RunPlan", description: "Execute a native coding plan with its required checks." },
    { name: "coding/dispatch", delegate: "coding/RunDispatch", description: "Run one dispatched agent turn in this workspace." },
    { name: "coding/implementation", delegate: "coding/Implement", description: "Implement one native coding atom." }
  ]
  const modules = new Map<string, { body: string; declaration: unknown }>()
  for (const entry of entries) {
    const directory = path.join(root, entry.name)
    yield* fs.makeDirectory(directory, { recursive: true })
    const config = { description: entry.description, capabilities: ["*"], flows: [entry.delegate],
      budget: { tokens: deploymentTokens, milliseconds: deploymentMinutes * 60000 } }
    const body = `import { Flow } from "@smthrs/core"\nimport { Schema } from "effect"\n// Bundled repository policy ${policy}.\nexport default Flow.make({ description: ${JSON.stringify(entry.description)}, capabilities: ["*"], flows: [${JSON.stringify(entry.delegate)}], budget: { tokens: ${deploymentTokens}, milliseconds: ${deploymentMinutes * 60000} }, input: Schema.Unknown, output: Schema.Unknown })\n`
    const file = path.join(directory, "flow.ts")
    const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    if (previous !== body) yield* fs.writeFileString(file, body)
    // Discovery reads ordinary modern declaration bytes. The deployed bundle
    // supplies their exact Flow value; target repos need no package imports.
    modules.set(path.resolve(file), { body, declaration: CoreFlow.make({ ...config, input: Schema.Unknown, output: Schema.Unknown }) })
  }
  const registry = yield* Registry.make({ sources: [{ root, source: "repository-host", naming: "path", system: true }] }).pipe(Effect.provide(Discovery.layer))
  const load: NonNullable<Executable.Options["load"]> = (file, source) => {
    const entry = modules.get(path.resolve(file))
    return entry !== undefined && new TextDecoder().decode(source.bytes) === entry.body && Digest.digest(entry.body) === source.contentDigest
      ? Effect.succeed({ default: entry.declaration }) : Effect.fail(new Error("Bundled declaration bytes changed"))
  }
  return { registry, load }
})

/** Project modules retain their normal verified import loader; built-ins use
 * the value compiled into this same host bundle after exact-byte admission. */
export const repositoryCatalog = (options: Executable.Options, load: NonNullable<Executable.Options["load"]>) => Effect.gen(function*() {
  const registry = yield* Registry.Registry, descriptors = yield* registry.list()
  const selected = (bundled: boolean) => Registry.Registry.of({ ...registry,
    list: () => Effect.succeed(descriptors.filter(entry => (entry.provenance.source === "repository-host") === bundled)) })
  const project = yield* Executable.catalog(options).pipe(Effect.provideService(Registry.Registry, selected(false)))
  const builtins = yield* Executable.catalog({ ...options, load }).pipe(Effect.provideService(Registry.Registry, selected(true)))
  return { executables: [...project.executables, ...builtins.executables], refused: [...project.refused, ...builtins.refused] }
})

/** Reserved job declarations always come from the measured host bundle. */
export const bindRepositoryRegistry = (base: Registry.Registry, builtins: Registry.Registry, policy: string): Registry.Registry => {
  const reserved = (name: string) => name === "repository/setup" || name === "repository/trigger" || /^repository-jobs\/(issues|review|ci|feature|chores)$/.test(name)
  const reservedSchemas = (name: string) => name === "repository/setup" ? { input: SetupInput, output: OperationResult }
    : name === "repository/trigger" ? { input: TriggerRequest, output: TriggerOutcome } : { input: JobInput, output: JobResult }
  const derived = (descriptor: Descriptor.FlowDescriptor) => reserved(descriptor.name) ? new Descriptor.FlowDescriptor({ ...descriptor,
    budget: { tokens: deploymentTokens, milliseconds: deploymentMinutes * 60000 },
    input: new Descriptor.SchemaRefInline({ document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(reservedSchemas(descriptor.name).input))) }),
    output: new Descriptor.SchemaRefInline({ document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(reservedSchemas(descriptor.name).output))) }),
    frontmatter: { ...descriptor.frontmatter, repositoryHostPolicy: policy }
  }) : descriptor
  const owned = (name: string) => reserved(name) ? Effect.succeed(builtins) : base.getOption(name).pipe(Effect.map(found => Option.isSome(found) ? base : builtins))
  const get = (name: string) => owned(name).pipe(Effect.flatMap(registry => registry.get(name)), Effect.map(derived))
  const list = () => Effect.all([base.list(), builtins.list()]).pipe(Effect.map(([project, defaults]) => [
    ...project.filter(entry => !reserved(entry.name)), ...defaults.filter(entry => reserved(entry.name) || !project.some(candidate => candidate.name === entry.name))
  ].map(derived)))
  const loadBody: Registry.Registry["loadBody"] = (name, expected) => Effect.gen(function*() {
    const registry = yield* owned(name), original = yield* registry.get(name), descriptor = derived(original)
    if (expected !== undefined && Descriptor.executionDigest(descriptor) !== expected) return yield* registryError({
      code: "execution_changed", method: "loadBody", path: descriptor.path, description: "Repository host policy changed after planning" })
    return yield* registry.loadBody(name, Descriptor.executionDigest(original))
  })
  return Registry.Registry.of({ list, visible: () => list().pipe(Effect.map(entries => entries.filter(entry => entry.modelInvocable))), get,
    getOption: name => get(name).pipe(Effect.map(Option.some), Effect.catch(() => Effect.succeedNone)), loadBody,
    runPrompt: (name, input) => loadBody(name).pipe(Effect.flatMap(body => body._tag === "Prompt" ? Effect.succeed(MarkdownFlow.renderPrompt(body, input))
      : Effect.fail(registryError({ code: "not_prompt_flow", method: "runPrompt", description: "The selected flow is module-backed" })))),
    refresh: () => Effect.all([base.refresh(), builtins.refresh()]).pipe(Effect.asVoid),
    warnings: () => Effect.all([base.warnings(), builtins.warnings()]).pipe(Effect.map(values => values.flat()))
  })
}
