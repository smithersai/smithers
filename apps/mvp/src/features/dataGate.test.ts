import { join, resolve } from "node:path"
import ts from "typescript"
import { expect, test } from "vitest"

// Decision 0110/W9: display stores cannot be composed without the repository authority. Check the public layer
// contracts with the compiler, as device/dataGate.test.ts checks raw reads. Providing RepoStore must satisfy exactly
// this requirement; the feature suites exercise the resulting queries with the real authority.
const ROOT = resolve(import.meta.dirname, "../..")
const STORES = ["Plugins", "HomeStore", "FilesStore", "DomainsStore", "SecretsStore", "FleetStore", "RunsStore"] as const
const source = `
  import { Layer } from "effect"
  import { RepoStore } from "./repo/store"
  import { Plugins } from "../plugins/plugins"
  import { HomeStore } from "./home/store"
  import { FilesStore } from "./files/store"
  import { DomainsStore } from "./domains/store"
  import { SecretsStore } from "./secrets/store"
  import { FleetStore } from "./fleet/store"
  import { RunsStore } from "./runs/store"
  const config = { origin: "https://unused.test" }
  const layers = {
    Plugins: Plugins.layer(), HomeStore: HomeStore.layer, FilesStore: FilesStore.layer,
    DomainsStore: DomainsStore.layer(config), SecretsStore: SecretsStore.layer(config),
    FleetStore: FleetStore.layer(config), RunsStore: RunsStore.layer(config),
  }
  declare const authority: Layer.Layer<RepoStore>
  ${STORES.map((name) => `
    export const ${name}Required: [RepoStore] extends [Layer.Services<typeof layers.${name}>] ? true : false = true
    const ${name}Provided = Layer.provide(layers.${name}, authority)
    export const ${name}Satisfied: [RepoStore] extends [Layer.Services<typeof ${name}Provided>] ? false : true = true
  `).join("\n")}
`

let probe: { readonly program: ts.Program; readonly file: ts.SourceFile }
const compile = () => {
  if (probe !== undefined) return probe
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    },
  })!
  const name = join(ROOT, "src/features/authority-probe.ts")
  const host = ts.createCompilerHost(parsed.options)
  const original = host.getSourceFile
  host.getSourceFile = (path, version) => path === name ? ts.createSourceFile(path, source, version) : original.call(host, path, version)
  const program = ts.createProgram({ rootNames: [name], options: parsed.options, host })
  return probe = { program, file: program.getSourceFile(name)! }
}

test.each(STORES)("%s requires RepoStore and accepts its authority layer", (name) => {
  const { program, file } = compile()
  const diagnostics = program.getSemanticDiagnostics(file).filter((diagnostic) => {
    const start = diagnostic.start ?? 0
    const line = file.text.slice(0, start).split("\n").length - 1
    return file.text.split("\n")[line]?.includes(`export const ${name}`)
  })
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
}, 240_000)

test("the authority probe resolves every store and its composition", () => {
  const { program, file } = compile()
  const diagnostics = program.getSemanticDiagnostics(file).filter((diagnostic) => {
    const line = file.text.slice(0, diagnostic.start ?? 0).split("\n").length - 1
    return !file.text.split("\n")[line]?.includes("export const")
  })
  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
}, 240_000)
