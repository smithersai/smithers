/**
 * Produce native declaration inputs before TypeScript-only tools read exports.
 * Generation checks each native source and its imports with its own project
 * options; the ordinary project checks still own unrelated TypeScript and tests.
 * @since 0.1.0
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeLoaderRecord } from "vibelang/project"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const repository = resolve(import.meta.dirname, "../../..")
const excluded = new Set([
  "node_modules", ".jj", ".git", ".vibe", ".vibelang", ".cache", ".artifacts", ".flows",
  "dist", "out", "coverage", "test-results", "test", "tests", "__tests__", "__mocks__",
  "fixture", "fixtures", "__fixtures__", "test-fixtures", "testdata", "e2e", "vendor", "vendored", "third_party", "third-party"
])
const slash = path => path.split("\\").join("/")

// A package's src/test holds published test helpers (an export map names their sidecars), not tests.
const skipped = (directory, name) => excluded.has(name) && !(name === "test" && basename(directory) === "src")

const nativeFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.isSymbolicLink() || skipped(directory, entry.name)) return []
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

const within = (directory, file) => {
  const path = relative(directory, file)
  return path !== "" && !path.startsWith("..") && !isAbsolute(path)
}

// The compiler places each sidecar relative to the common directory of every source in the
// generation program. That directory depends on which files the program reaches: only src when
// the native files all sit there, or a workspace ancestor once the vibelang-source condition
// pulls in another package's sources. TypeScript pairs a source with its sidecar through
// rootDirs, so the sidecar belongs under the deepest rootDirs entry that holds every native source.
const sourceRoot = project => (project.parsed.options.rootDirs ?? [])
  .map(directory => resolve(directory))
  .filter(directory => project.native.every(file => within(directory, file)))
  .sort((a, b) => b.length - a.length)[0]

const sidecarName = (from, file) => relative(from, file).replace(/\.vibe$/, ".d.vibe.ts")

// Move each native source's sidecar from wherever the compiler wrote it to the path rootDirs
// pairs with the source, then drop what the program wrote for other packages' sources. The
// compiler used one common directory for the whole program: the deepest ancestor of the native
// sources under which every one of their sidecars exists.
const relocate = project => {
  let common = project.native.map(dirname).reduce((a, b) => {
    while (!within(a, b) && a !== b) a = dirname(a)
    return a
  })
  while (!project.native.every(file => existsSync(join(project.sidecarDir, sidecarName(common, file))))) {
    if (dirname(common) === common) throw new Error("No sidecars were generated for " + project.config)
    common = dirname(common)
  }
  const staging = project.sidecarDir + ".relocating-" + process.pid
  rmSync(staging, { recursive: true, force: true })
  for (const file of project.native) {
    const written = join(project.sidecarDir, sidecarName(common, file))
    const target = join(project.sidecarDir, sidecarName(project.rootDir, file))
    const staged = join(staging, sidecarName(project.rootDir, file))
    mkdirSync(dirname(staged), { recursive: true })
    // A specifier between sidecars keeps working because every sidecar moves by the same offset;
    // one that reaches a real file outside the sidecar directory is recomputed from the new place.
    const text = readFileSync(written, "utf8").replace(
      /(\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|<reference\s+path=)(["'])(\.\.?\/[^"']*)\2/g,
      (whole, lead, quote, specifier) => {
        const reached = resolve(dirname(written), specifier)
        if (within(project.sidecarDir, reached)) return whole
        const moved = slash(relative(dirname(target), reached))
        return lead + quote + (moved.startsWith(".") ? moved : "./" + moved) + quote
      }
    )
    writeFileSync(staged, text)
    rmSync(written)
  }
  rmSync(project.sidecarDir, { recursive: true, force: true })
  renameSync(staging, project.sidecarDir)
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
    const rootDir = sourceRoot(project)
    const sidecarDir = project.parsed.raw?.vibe?.sidecarDir
    return {
      ...(rootDir === undefined ? {} : { rootDir }),
      ...(rootDir === undefined || typeof sidecarDir !== "string" ? {} : { sidecarDir: resolve(dirname(project.config), sidecarDir) }),
      native: [...project.native].sort(),
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

const sidecarNames = directory => directory !== undefined && existsSync(directory)
  ? readdirSync(directory, { recursive: true }).filter(name => name.endsWith(".d.vibe.ts"))
  : []

// A loader compile writes sidecars at the compiler's own layout, not where relocate
// placed them. They are outputs and no record names them, so they can go.
const removeSidecar = (sidecarDir, name) => {
  rmSync(join(sidecarDir, name), { force: true })
  for (let directory = dirname(join(sidecarDir, name)); within(sidecarDir, directory); directory = dirname(directory)) {
    try { rmdirSync(directory) } catch { break }
  }
}

// A process started from source compiles every project it reaches when its compile
// cache is cold, as it always is on a fresh checkout, which takes most of a minute on a
// small machine. A loader record serves that compile while its inputs' digests hold.
// Records read the sidecars, so they follow all of them. A project the loader cannot
// compile is left without one, and reports its errors where it runs.
const writeLoaderRecords = (root, projects, stdio) => {
  for (const project of projects) {
    const placed = new Set(sidecarNames(project.sidecarDir))
    try {
      writeLoaderRecord({ project: project.config })
    } catch (error) {
      if (stdio === "inherit") console.warn("No loader record for " + slash(relative(root, project.config)) + ": " + error.message)
    } finally {
      for (const name of sidecarNames(project.sidecarDir)) if (!placed.has(name)) removeSidecar(project.sidecarDir, name)
    }
  }
}

/** Generate with strict source checking; leave no temporary configurations.
 * @category build
 * @since 0.1.0
 */
export const prepareSidecars = (root = repository, { stdio = "inherit" } = {}) => {
  root = resolve(root)
  const projects = sidecarProjects(root)
  const failed = []
  const generated = []
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
      if (project.sidecarDir !== undefined) rmSync(project.sidecarDir, { recursive: true, force: true })
      const result = spawnSync(process.execPath, [compiler, "-p", temporary], { cwd: directory, stdio, encoding: "utf8" })
      if (!result.error && result.status === 0) {
        if (project.sidecarDir !== undefined) relocate(project)
        generated.push(project)
      }
      if (result.error || result.status !== 0) failed.push(
        slash(relative(root, project.config)) + ": declaration generation failed (" + (result.status ?? result.error?.message ?? result.signal) + ")" +
        (stdio === "pipe" ? "\n" + (result.stdout ?? "") + (result.stderr ?? "") : "")
      )
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  // One project's failure must not cost every other project its record: without
  // records, each cold start of any project compiles the whole workspace again.
  writeLoaderRecords(root, generated, stdio)
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
