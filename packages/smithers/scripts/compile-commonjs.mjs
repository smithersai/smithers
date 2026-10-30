/** Builds the CommonJS half of a package's dual-module distribution. */
import { build } from "esbuild"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import ts from "typescript"
import { copyCommonJsDeclarations, nodeCommonJsOptions } from "../../repo-targets/scripts/build-library.mjs"
import { buildPrivateEffectAdapters } from "../../repo-targets/scripts/private-effect-adapters.mjs"

const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

const hasTopLevelAwait = (file) => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return false
    if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier) return true
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(source)
}

/**
 * Keeps executable-only top-level-await modules as thin ESM delegates.
 *
 * esbuild cannot read `.vibe`, so a package with VibeLang sources converts the
 * ESM branch vibelang emitted, which holds every module the sources compiled
 * to; a TypeScript package converts its sources.
 */
export const compileCommonJs = async (src, cjs, esm) => {
  const sourceFiles = files(src)
  const vibe = sourceFiles.some((file) => file.endsWith(".vibe"))
  const input = vibe ? esm : src
  const tsFiles = vibe ? [] : sourceFiles.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  const jsFiles = vibe
    ? files(esm).filter((file) => file.endsWith(".js"))
    : sourceFiles.filter((file) => file.endsWith(".js") && !existsSync(file.replace(/\.js$/, ".ts")))
  const executableEntries = [...tsFiles, ...jsFiles].filter(hasTopLevelAwait)
  await build({
    entryPoints: [...tsFiles, ...jsFiles].filter((file) => !executableEntries.includes(file)),
    outbase: input,
    outdir: cjs,
    format: "cjs",
    bundle: false,
    ...nodeCommonJsOptions,
    sourcemap: true
  })
  for (const file of files(cjs).filter((file) => file.endsWith(".js"))) {
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/((?:require|import)\(["'](?:\.\.?\/)[^"']+)\.ts(["']\))/g, "$1.js$2")
    )
  }
  mkdirSync(cjs, { recursive: true })
  writeFileSync(join(cjs, "package.json"), "{\"type\":\"commonjs\"}\n")
  for (const file of executableEntries) {
    const target = join(cjs, relative(input, file).replace(/\.(?:ts|js)$/, ".js"))
    const executable = join(esm, relative(input, file).replace(/\.(?:ts|js)$/, ".js"))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      `void import(${
        JSON.stringify(relative(dirname(target), executable))
      }).catch((error) => { console.error(error); process.exitCode = 1 })\n`
    )
  }
  // JSON imported by source modules (including the generated command catalog)
  // must accompany the unbundled CommonJS modules just as it does tsc's ESM.
  for (const file of sourceFiles.filter((file) => file.endsWith(".json"))) {
    const target = join(cjs, relative(src, file))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(file, target)
  }
  copyCommonJsDeclarations(dirname(src))
  await buildPrivateEffectAdapters(dirname(src))
}
