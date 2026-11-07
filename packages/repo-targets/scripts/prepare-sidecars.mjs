/**
 * Produce native declaration inputs before TypeScript-only tools read exports.
 * Generation checks each native source and its imports with its own project
 * options; the ordinary project checks still own unrelated TypeScript and tests.
 * @since 0.1.0
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const repository = resolve(import.meta.dirname, "../../..")
const excluded = new Set([
  "node_modules", ".jj", ".git", ".vibe", ".vibelang", ".cache", ".artifacts", ".flows",
  "dist", "out", "coverage", "test-results", "test", "tests", "__tests__", "__mocks__",
  "fixture", "fixtures", "__fixtures__", "test-fixtures", "testdata", "e2e", "vendor", "vendored", "third_party", "third-party"
])
const slash = path => path.split("\\").join("/")

const nativeFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.isSymbolicLink() || excluded.has(entry.name)) return []
  const file = join(directory, entry.name)
  if (entry.isDirectory()) return nativeFiles(file)
  return entry.name.endsWith(".vibe") && !/\.(?:test|spec|bench|test-d|e2e|integration)\.vibe$/.test(entry.name) &&
      !entry.name.startsWith(".smithers-")
    ? [file]
    : []
})

const readProject = file => {
  const read = ts.readConfigFile(file, ts.sys.readFile)
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file), undefined, file, undefined, [
    { extension: ".vibe", isMixedContent: false, scriptKind: ts.ScriptKind.Deferred }
  ])
  const errors = parsed.errors.filter(error => error.code !== 18003)
  if (errors.length) throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"))
  return parsed
}

const generatedDeclaration = file => /\.d\.vibe\.ts$|\.vibe\.[^/]+\.d\.[cm]?ts$/.test(file)

const ambientContext = project => {
  // Preserve globals and library references introduced by any original root,
  // without adding unrelated module bodies to declaration generation.
  const roots = project.parsed.fileNames.filter(file => !file.endsWith(".vibe") && !generatedDeclaration(file))
  const program = ts.createProgram(roots, project.parsed.options)
  const files = []
  const libs = []
  for (const source of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(source)) {
      const name = /^lib\.(.+)\.d\.ts$/.exec(basename(source.fileName))?.[1]
      if (name !== undefined && !name.endsWith(".full")) libs.push(name)
    } else if (!generatedDeclaration(source.fileName) && (
      source.isDeclarationFile ||
      (roots.some(file => slash(file) === slash(source.fileName)) && (!source.externalModuleIndicator ||
        source.statements.some(node => ts.isModuleDeclaration(node) &&
          ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || ts.isStringLiteral(node.name)))))
    )) files.push(source.fileName)
  }
  return { files, libs: [...new Set(libs)].sort() }
}

/** Native roots and ambient inputs, retaining each original configuration.
 * @category build
 * @since 0.1.0
 */
export const sidecarProjects = (root = repository) => {
  root = resolve(root)
  const projects = new Map()
  for (const file of nativeFiles(root)) {
    let directory = dirname(file)
    while (!existsSync(join(directory, "tsconfig.json")) && directory !== root) directory = dirname(directory)
    const config = join(directory, "tsconfig.json")
    if (!existsSync(config)) throw new Error("No project for " + relative(root, file))
    if (!projects.has(config)) projects.set(config, { config, parsed: readProject(config), native: [] })
    const project = projects.get(config)
    if (project.parsed.fileNames.some(rootFile => slash(rootFile) === slash(file))) project.native.push(file)
  }
  return [...projects.values()].filter(project => project.native.length).map(project => {
    const ambient = ambientContext(project)
    return {
      config: project.config,
      files: [...new Set([...project.native, ...ambient.files])].sort(),
      libs: ambient.libs,
      conditions: [...new Set([...(project.parsed.options.customConditions ?? []), "vibelang-source"])]
    }
  }).sort((a, b) => {
    const phase = file => slash(relative(root, file)).startsWith("packages/") ? 0 : 1
    return phase(a.config) - phase(b.config) || a.config.localeCompare(b.config)
  })
}

/** Generate with strict source checking; leave no temporary configurations.
 * @category build
 * @since 0.1.0
 */
export const prepareSidecars = (root = repository, { stdio = "inherit" } = {}) => {
  root = resolve(root)
  const projects = sidecarProjects(root)
  const failed = []
  for (const project of projects) {
    const directory = dirname(project.config)
    const localRequire = createRequire(project.config)
    const compiler = join(dirname(localRequire.resolve("vibelang/package.json")), "bin/vibelang")
    const temporary = join(directory, ".tsconfig.vibelang-sidecars-" + process.pid + ".json")
    writeFileSync(temporary, JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: true, customConditions: project.conditions, ...(project.libs.length ? { lib: project.libs } : {}) },
      files: project.files.map(file => "./" + slash(relative(directory, file))),
      include: [],
      exclude: []
    }) + "\n")
    try {
      if (stdio === "inherit") console.log("Generating declarations: " + slash(relative(root, project.config)))
      const result = spawnSync(process.execPath, [compiler, "-p", temporary], { cwd: directory, stdio, encoding: "utf8" })
      if (result.error || result.status !== 0) failed.push(
        slash(relative(root, project.config)) + ": declaration generation failed (" + (result.status ?? result.error?.message ?? result.signal) + ")" +
        (stdio === "pipe" ? "\n" + (result.stdout ?? "") + (result.stderr ?? "") : "")
      )
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  if (failed.length) throw new Error(failed.join("\n"))
  return projects.length
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = prepareSidecars()
    console.log("Generated declaration sidecars for " + count + " projects")
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
