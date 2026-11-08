/** Private deployment artifact; the existing Plue provisioner stages one executable. */
import { build } from "esbuild"
import vibelang from "vibelang-unplugin/esbuild"
import { chmod, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { policySources } from "../wiki/reuse.ts"
import { builtinDefaults, shipsWithDefault } from "../repository/builtin-defaults.ts"
import { hostModulesSource } from "./host-modules-build.mjs"
import { typecheckInputs, typecheckSource } from "./flow-typecheck-build.mjs"
import { wikiPolicyIdentity } from "./wiki-policy.ts"

/**
 * The largest coding host Plue stages into a hosted workspace: eight base64
 * chunks of 16 MiB, each one request inside the 64 MiB body limit. At
 * 915058c5 the host outgrew Plue's earlier 48 MiB limit and every hosted
 * coding turn failed (plue#863). Keep it equal to `maxPackagedFlowHostBytes`
 * in plue's apps/backend/internal/composition/workspaceruntime/services.go.
 */
export const stagedHostLimitBytes = 128 * 1024 * 1024

/** Refuses a coding host Plue could not stage. */
export const checkStagedHostSize = (bytes) => {
  if (bytes > stagedHostLimitBytes) {
    throw new Error(`Coding host is ${bytes} bytes; Plue stages at most ${stagedHostLimitBytes} (plue#863)`)
  }
}

/**
 * The files a packaged default ships, relative to its directory: `flow.ts` and
 * its `src/` tree (`shipsWithDefault`). Only those are listed. Node's recursive
 * readdir follows directory links, and a default that is also a workspace
 * package has a node_modules whose links lead back into the workspace.
 */
export const defaultFiles = async (directory) => {
  const top = await readdir(directory)
  const source = top.includes("src") ? await readdir(resolve(directory, "src"), { recursive: true }) : []
  return [...top, ...source.map(entry => `src/${entry.replaceAll("\\", "/")}`)].filter(shipsWithDefault).sort()
}

/**
 * An export's source file: the target itself, or for a migrated package the `vibelang-source` condition, at any
 * depth, since its `default` names emitted JavaScript.
 */
const sourceTarget = (entry) => {
  if (typeof entry === "string") return entry
  if (entry === null || typeof entry !== "object") return undefined
  if (typeof entry["vibelang-source"] === "string") return entry["vibelang-source"]
  for (const nested of Object.values(entry)) {
    const target = typeof nested === "object" ? sourceTarget(nested) : undefined
    if (target !== undefined) return target
  }
  return undefined
}

/** Used to build the same runtime acceptance entry with the deployment bundler; not a package export. */
export const bundle = async (entryPoint, outfile) => {
  // Resolve workspace packages from this checkout even when node_modules is
  // shared with another worktree. Otherwise a release silently bundles old code.
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  const alias = {}, typeAlias = {}, roots = {}
  for (const pattern of manifest.workspaces) {
    const paths = pattern.endsWith("/*")
      ? (await readdir(resolve(root, pattern.slice(0, -2)), { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => resolve(root, pattern.slice(0, -2), entry.name))
      : [resolve(root, pattern)]
    for (const path of paths) {
      try {
        const pkg = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"))
        if (pkg.name) {
          roots[pkg.name] = path
          for (const [key, entry] of Object.entries(pkg.exports ?? {})) {
            const target = sourceTarget(entry)
            if (typeof target !== "string" || key.includes("*")) continue
            alias[pkg.name + (key === "." ? "" : key.slice(1))] = resolve(path, target)
            // Types read a `.vibe` module's sidecar at the path beside its source (flow-typecheck-build.mjs), the one
            // path its package's own relative imports reach too, so the shipped graph has one declaration of it.
            typeAlias[pkg.name + (key === "." ? "" : key.slice(1))] = resolve(path, target.replace(/\.vibe(x?)$/, ".d.vibe$1.ts"))
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }
  const options = {
    alias, absWorkingDir: root,
    define: { __filename: "import.meta.filename", __dirname: "import.meta.dirname" },
    entryPoints: [entryPoint], outfile, write: false, bundle: true, platform: "node", format: "esm", target: "node26.4",
    banner: { js: "#!/usr/bin/env node\nimport {createRequire as __smithersCreateRequire} from 'node:module'; const require=__smithersCreateRequire(import.meta.url);" }
  }
  const lazyBunSqlite = {
    name: "lazy-bun-sqlite",
    setup(build) {
      // esbuild hoists static external imports from dynamically loaded ESM
      // modules. Keep Bun's existing builtin behind that same lazy boundary,
      // so a Node launch never attempts to resolve bun:sqlite.
      build.onResolve({ filter: /^bun:sqlite$/ }, args => args.namespace === "lazy-bun-sqlite"
        ? { path: args.path, external: true }
        : { path: args.path, namespace: "lazy-bun-sqlite" })
      // Every name the bundled modules take from bun:sqlite has to be named
      // here: esbuild resolves an ESM named import against this module's own
      // exports, so one it does not re-export fails the build rather than the
      // launch. `@smthrs/database`'s Bun client reads `constants` for its
      // open flags.
      build.onLoad({ filter: /.*/, namespace: "lazy-bun-sqlite" }, () => ({
        contents: 'const native = await import("bun:sqlite");'
          + " export const Database = native.Database; export const constants = native.constants;",
        loader: "js"
      }))
    }
  }
  // A repository's file flows share the host's own modules (host-modules.ts).
  // The probe learns which modules the host runs; the build then serves
  // exactly those, so sharing adds no module of its own.
  // vibelang-unplugin compiles the `.vibe` modules of the workspace packages
  // the host bundles from source, each with its own package's tsconfig.
  const vibe = () => vibelang({ root: fileURLToPath(new URL(".", import.meta.url)) })
  const probe = await build({ ...options, metafile: true, plugins: [vibe(), lazyBunSqlite] })
  // Only modules the host evaluates at start: sharing a module the host only
  // imports dynamically (Bun's platform layers) would evaluate it eagerly.
  const graph = probe.metafile.inputs, inputs = new Set()
  const pending = Object.keys(graph).filter(path => resolve(root, path) === resolve(entryPoint))
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    // A `.vibe` module is a file the plugin loads in its own namespace.
    const file = path.startsWith("vibelang:") ? path.slice("vibelang:".length) : path
    if (file.includes(":") || inputs.has(resolve(root, file))) continue
    inputs.add(resolve(root, file))
    for (const edge of graph[path]?.imports ?? []) if (!edge.external && edge.kind !== "dynamic-import") pending.push(edge.path)
  }
  const result = await build({
    ...options,
    plugins: [vibe(), {
      name: "host-modules",
      setup(build) {
        build.onLoad({ filter: /[\\/]flows[\\/]coding[\\/]host-modules\.ts$/ }, async ({ path }) => ({
          contents: await hostModulesSource(await readFile(path, "utf8"), inputs, alias, roots), loader: "ts"
        }))
      }
    }, lazyBunSqlite]
  })
  if (result.outputFiles.length !== 1) throw new Error("Coding host must be one immutable executable")
  // The built-in prompt bodies travel with the executable.
  //
  // They are `.mdx` files in this repository and the deployment carries no
  // repository tree, so the host would have nothing to install on a workspace.
  // They go in BEFORE the artifact is hashed, so the policy digest a workspace
  // records covers the exact prompts it will run: editing one respins the
  // host, as it should.
  const packRoot = fileURLToPath(new URL("../create-flow/", import.meta.url))
  const pack = {}
  for (const name of ["", "clarify", "provision", "design", "scaffold", "fix", "document"]) {
    const file = resolve(packRoot, name, "flow.mdx")
    pack[name === "" ? "create-flow" : `create-flow/${name}`] = await readFile(file, "utf8")
  }
  for (const name of ["issue/repro", "issue/poc", "pr-triage", "review/change"]) {
    pack[name] = await readFile(resolve(root, ".smithers", "flows", name, "flow.mdx"), "utf8")
  }
  // The wiki review task's identity, from the same policy files the source
  // host reads. Review reuse keys on it, so a host build that leaves the
  // review task alone keeps prior reviews (#1971).
  const policyTexts = new Map()
  for (const source of policySources) policyTexts.set(source, await readFile(resolve(root, source), "utf8"))
  // The packaged default flows travel with the executable the same way: each
  // entry and the modules beside it, so the host writes and measures exactly
  // the closure it compiled (.smithers/flows/repository/builtin-defaults.ts).
  const defaults = {}
  for (const name of builtinDefaults) {
    const directory = resolve(root, ".smithers", "flows", name)
    for (const relative of await defaultFiles(directory)) {
      defaults[`${name}/${relative}`] = await readFile(resolve(directory, relative), "utf8")
    }
  }
  const flowTypes = await typecheckInputs(root, typeAlias)
  const compiled = result.outputFiles[0].text.replace(/^(#![^\n]*\n)/,
    (banner) => `${banner}${typecheckSource(flowTypes)}const __SMITHERS_CREATE_FLOW_PACK__ = ${JSON.stringify(pack)};\nconst __SMITHERS_CODING_WIKI_POLICY__ = ${JSON.stringify(wikiPolicyIdentity(policyTexts))};\nconst __SMITHERS_BUILTIN_DEFAULTS__ = ${JSON.stringify(defaults)};\n`)
  if (compiled === result.outputFiles[0].text) throw new Error("Coding artifact has no executable banner")
  const digest = createHash("sha256").update(compiled).digest("hex")
  // Hash the exact compiled artifact before inserting its own identity. This
  // includes its complete bundled dependency graph, with no dependency on files
  // vendored in the target repository.
  const output = compiled.replace(/^(#![^\n]*\n)/,
    `$1const __SMITHERS_CODING_ARTIFACT_DIGEST__ = ${JSON.stringify(digest)};\n`)
  if (output === compiled) throw new Error("Coding artifact has no executable banner")
  checkStagedHostSize(Buffer.byteLength(output))
  await mkdir(dirname(resolve(outfile)), { recursive: true })
  await writeFile(outfile, output)
  await chmod(outfile, 0o755)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outfile = resolve(process.argv[2] ?? "dist/coding-host/smithers.mjs")
  await bundle(fileURLToPath(new URL("./serve.ts", import.meta.url)), outfile)
  process.stdout.write(`${outfile}\n`)
}
