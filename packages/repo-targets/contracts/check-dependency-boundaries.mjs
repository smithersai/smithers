#!/usr/bin/env node
/**
 * Every import a workspace source makes must be declared by that workspace.
 *
 * pnpm links the whole workspace under one `node_modules`, so a package can
 * import a sibling it never declared and still resolve locally. A consumer who
 * installs the published tarball gets a module-not-found error instead. This
 * This gate prevents package imports through unpublished workspace-relative
 * paths: a bare specifier must name a declared dependency, and a relative
 * specifier must not resolve into another workspace package's `src/`, which
 * a tarball consumer can only reach through that package's export map.
 *
 * Test files, config files, and anything under a `scripts/` directory may use
 * `devDependencies`; everything else may use only runtime, peer, and optional
 * dependencies, or validated private adapters vendored into the distribution.
 *
 * It also enforces "Everything is a durable flow" in the root `AGENTS.md`: no
 * source file anywhere under `apps/` or `packages/` (tests, scripts and Worker
 * entries included) imports another durable runtime or model SDK in place of
 * `@smthrs/flow`. See {@link bannedImportsInSource} for the list.
 *
 * Run it with `pnpm exec smithers-build test '//packages/repo-targets:dependencyBoundaries'`, or
 * directly with `node packages/repo-targets/contracts/check-dependency-boundaries.mjs`.
 */
import { builtinModules } from "node:module"
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"

import { analyze, specifiers } from "../src/ImportAnalysis.ts"
import { workspacePackages, isMain, repoRoot } from "../scripts/workspace-packages.mjs"
import { privateEffectAdapters } from "../scripts/private-effect-adapters.mjs"

// Resolved from this file, not from `process.cwd()`: the build system runs a
// target from the directory that owns it, and this gate is about the whole
// workspace.
// Membership comes from `pnpm-workspace.yaml` through the shared reader, so a
// package nested inside the product package it belongs to
// (`packages/smithers/flows/canonical`) is checked like any other. This gate scans
// `packages/` and `apps/`, and the offline eval suites stay out: they are
// private, never published, and import the source of the package they measure
// directly, as they did when they lived under `evals/` (#4090).
const scannedRoots = ["packages/", "apps/"]
// These are source excerpts displayed by the decision queue, not modules the
// maintainer app loads (e1efaba2 and 0c455cbe). Keep the exception at its exact
// data roots: executable app code and other packages' fixtures remain checked.
const reviewSnapshotRoots = [
  "apps/maintainer-site/queue/before/",
  "apps/maintainer-site/test/fixtures/"
]
const evalSuites = [
  "packages/smithers/agent/regression",
  "packages/smithers/agent/harness/benchmarks/"
]
const isEvalSuite = (dir) => evalSuites.some((suite) => suite.endsWith("/") ? dir.startsWith(suite) : dir === suite)
// VibeLang sources (`.vibe`) import like TypeScript ones and are read the same way.
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vibe"])
const ignoredDirs = new Set([
  ".alchemy",
  ".flows",
  ".git",
  ".jj",
  ".claude",
  ".smithers",
  ".turbo",
  ".worktrees",
  "worktrees",
  "coverage",
  "dist",
  "eval-runs",
  "node_modules",
  "target",
  "tmp",
])
const builtinPackages = new Set(["bun", ...builtinModules, ...builtinModules.map((mod) => `node:${mod}`)])
// Reach-throughs that predate the rule, as `file -> specifier`. Each is a
// debt: the target is either an `internal/*` module its package deliberately
// does not export, or an app source no export map covers. Remove the entry
// when the import moves to a package name; the gate fails on a stale entry so
// the list only shrinks.
const knownReachThroughs = new Set([
  "PACKAGE.ts -> ./apps/site/src/data/project.json",
  "packages/smithers/build/infra/worker/test/action-cache.test.ts -> ../../../../flows/step-cache/src/CacheStore.ts",
])

// Banned imports that are the input of the 0.x migrator, as `file -> import`.
// Each fixture is a user's legacy project that `smithers-migrate` reads and
// rewrites; none of it runs as Smithers code. The gate fails on a stale entry
// so the list only shrinks.
const knownLegacyFixtureImports = new Set([
  "packages/smithers/migrate/test/fixtures/jsx-single/simple-workflow.jsx -> @ai-sdk/anthropic",
  "packages/smithers/migrate/test/fixtures/jsx-single/simple-workflow.jsx -> ai",
  "packages/smithers/migrate/test/fixtures/jsx-single/tests/_setup.ts -> ai",
  "packages/smithers/migrate/test/fixtures/persisted-db/simple-workflow.jsx -> @ai-sdk/anthropic",
  "packages/smithers/migrate/test/fixtures/persisted-db/simple-workflow.jsx -> ai",
])

/**
 * The end of every banned-import message: why, and where the rule lives.
 */
export const durableFlowRule =
  "every action, model calls included, runs as an @smthrs/flow step. " +
  "See \"Everything is a durable flow\" in AGENTS.md at the repository root."

/**
 * Packages that are another durable runtime or model SDK, by npm name. A
 * trailing `/` names a scope or a package's subpaths.
 */
const bannedPackages = [
  { names: ["ai", "@ai-sdk/"], runtime: "the Vercel AI SDK" },
  { names: ["@temporalio/"], runtime: "Temporal" },
  { names: ["inngest"], runtime: "Inngest" },
  { names: ["@trigger.dev/"], runtime: "Trigger.dev" },
  { names: ["langchain", "@langchain/"], runtime: "LangChain" },
  { names: ["@mastra/"], runtime: "Mastra" },
]

/**
 * Modules whose Workflow exports are Cloudflare Workflows. `whole` bans every
 * import of the module; otherwise an imported or accessed name is banned when
 * `names` matches it.
 */
const workflowModules = [
  { matches: (specifier) => specifier === "cloudflare:workflows", whole: true, runtime: "Cloudflare Workflows" },
  { matches: (specifier) => specifier === "cloudflare:workers", names: /^Workflow/, runtime: "Cloudflare Workflows" },
  {
    matches: (specifier) => /^alchemy\/Cloudflare\/Workflows(?:\/|$)/.test(specifier),
    whole: true,
    runtime: "Cloudflare Workflows through Alchemy",
  },
  {
    matches: (specifier) => /^alchemy\/Cloudflare(?:\/|$)/.test(specifier),
    // `task`, `sleep`, `sleepUntil` and `waitForEvent` are Alchemy's workflow
    // step functions, which `alchemy/Cloudflare` re-exports at its root.
    names: /Workflow|^(?:task|sleep|sleepUntil|waitForEvent)$/,
    runtime: "Cloudflare Workflows through Alchemy",
  },
]

/**
 * The runtime a specifier imports when the durable-flow rule bans the whole
 * module, or null.
 *
 * @param {string} specifier
 * @returns {string | null}
 */
export function bannedRuntimeForSpecifier(specifier) {
  const name = packageNameForSpecifier(specifier)
  if (name !== null) {
    for (const { names, runtime } of bannedPackages) {
      if (names.some((banned) => banned.endsWith("/") ? name.startsWith(banned) : name === banned)) return runtime
    }
  }
  return workflowModules.find((module) => module.whole && module.matches(specifier))?.runtime ?? null
}

/**
 * The runtime a name imported from, or read off, `specifier` belongs to when
 * the durable-flow rule bans it, or null.
 *
 * @param {string} specifier
 * @param {string} name
 * @returns {string | null}
 */
function bannedRuntimeForName(specifier, name) {
  return workflowModules.find((module) => module.names?.test(name) && module.matches(specifier))?.runtime ?? null
}

/** @typedef {{ file: string; line: number; specifier: string; name?: string; usage: string; runtime: string }} BannedImport */

/** @typedef {{ dir: string; name: string; manifestPath: string; manifest: Record<string, unknown> }} WorkspacePackage */

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} dir */
function readPackage(dir) {
  const manifestPath = join(repoRoot, dir, "package.json")
  if (!existsSync(manifestPath)) return null
  const manifest = readJson(manifestPath)
  if (!manifest?.name || typeof manifest.name !== "string") return null
  return { dir, name: manifest.name, manifestPath, manifest }
}

/** @returns {WorkspacePackage[]} */
function findWorkspacePackages() {
  /** @type {WorkspacePackage[]} */
  const packages = []
  for (const member of workspacePackages(repoRoot)) {
    if (!scannedRoots.some((root) => member.dir.startsWith(root)) || isEvalSuite(member.dir)) continue
    const pkg = readPackage(member.dir.split("/").join(sep))
    if (pkg) packages.push(pkg)
  }
  const rootPackage = readPackage(".")
  if (rootPackage) packages.push(rootPackage)
  return packages.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** @param {string} dir @param {string[]} out @param {string[]} [nestedPackageDirs] */
export function collectSourceFiles(dir, out, nestedPackageDirs) {
  if (reviewSnapshotRoots.some((root) => `${dir.split(sep).join("/")}/`.startsWith(root))) return
  const absDir = join(repoRoot, dir)
  if (!isDirectory(absDir)) return
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue
    const child = join(dir, entry)
    const absChild = join(repoRoot, child)
    // Skip symlinks before stat-following can recurse through workspace cycles
    // or crash on dangling local artifacts left by workflow runs.
    let stats
    try {
      stats = lstatSync(absChild)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      // A nested package.json with a name marks a standalone package (a
      // template, fixture, or shipped plugin). Its files are checked against
      // its own manifest, not the enclosing workspace's.
      if (nestedPackageDirs && readPackage(child)) {
        nestedPackageDirs.push(child)
        continue
      }
      collectSourceFiles(child, out, nestedPackageDirs)
      continue
    }
    if (!stats.isFile()) continue
    // Build-graph declarations belong to the root workspace, not the package
    // they sit in: the build CLI loads them from the repository root against
    // the root install. `collectGraphFiles` gives them to the root package.
    if (entry === "legacy declaration" || entry === "PACKAGE.ts") continue
    if (sourceExtensions.has(extname(entry))) out.push(child)
  }
}

/**
 * Collects every build-graph declaration in the tree, so the root workspace
 * checks them against the root manifest.
 *
 * The build CLI loads every `legacy declaration` from the repository root against the
 * root install, which is why an app's declaration may import
 * `@smthrs/targets` without the app declaring it. Declarations inside a
 * scaffolding template describe the app the template generates, not this
 * repository, so a directory holding a manifest that is not a workspace member
 * is not descended into.
 *
 * @param {string} dir Repo-relative POSIX path, or "" for the repository root.
 * @param {Set<string>} memberDirs Repo-relative directories of workspace members.
 * @param {string[]} out
 */
export function collectGraphFiles(dir, memberDirs, out) {
  const absDir = join(repoRoot, dir === "" ? "." : dir)
  if (!isDirectory(absDir)) return
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue
    const child = dir === "" ? entry : join(dir, entry)
    const absChild = join(repoRoot, child)
    let stats
    try {
      stats = lstatSync(absChild)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      const foreignProject = existsSync(join(absChild, "package.json")) &&
        !memberDirs.has(child) &&
        ![...memberDirs].some((member) => member.startsWith(`${child}${sep}`))
      if (foreignProject) continue
      collectGraphFiles(child, memberDirs, out)
      continue
    }
    if (entry === "legacy declaration" || entry === "PACKAGE.ts") out.push(child)
  }
}

/** @param {WorkspacePackage} pkg @param {Set<string>} [memberDirs] @returns {{ files: string[]; nestedPackageDirs: string[] }} */
function filesForPackage(pkg, memberDirs = new Set()) {
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const nestedPackageDirs = []
  if (pkg.dir === ".") {
    // The root workspace's own sources live under scripts/, and it owns
    // every build-graph declaration in the tree.
    collectSourceFiles("scripts", files, nestedPackageDirs)
    collectGraphFiles("", memberDirs, files)
  } else if (isDirectory(join(repoRoot, pkg.dir, "src"))) {
    collectSourceFiles(join(pkg.dir, "src"), files, nestedPackageDirs)
  } else {
    // Some workspaces have no src/ and keep their sources at the package root.
    // Scan the whole package dir; the recursive collector already skips
    // node_modules, dist, and coverage.
    collectSourceFiles(pkg.dir, files, nestedPackageDirs)
  }
  return { files: files.sort(), nestedPackageDirs: nestedPackageDirs.sort() }
}

/** @param {string} specifier */
export function packageNameForSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("~/") ||
    // A colon never appears in an npm package name: `node:`, `bun:`, `astro:`,
    // Vite's `virtual:` and a build plugin's own scheme are host modules.
    /^[a-z][a-z0-9+.-]*:/i.test(specifier)
  ) {
    return null
  }
  if (builtinPackages.has(specifier)) return null
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  }
  return parts[0] ?? null
}

/**
 * The workspace package whose `src/` a relative specifier resolves into, or
 * null when it stays outside every package source tree.
 *
 * `../../../packages/smithers/flows/plan/src/Plan.ts` from `.smithers/flows/bench/gate/corpus.mjs`
 * names `packages/smithers/flows/plan`; `../plan/PACKAGE.ts` from a sibling
 * build-graph declaration names nothing, because declarations are root-owned
 * and sit outside `src/`; `./src/index.ts` from `packages/repo-targets/PACKAGE.ts`
 * names nothing, because a declaration may load the package it sits in. The
 * caller decides whether the importing package is the same one; only a
 * different owner is a reach-through.
 *
 * @param {string} file Repo-relative path of the importing file.
 * @param {string} specifier
 * @param {Iterable<string>} packageDirs Repo-relative workspace package directories.
 * @returns {string | null}
 */
export function packageSourceReachedBy(file, specifier, packageDirs) {
  if (!specifier.startsWith(".")) return null
  const target = relative(repoRoot, resolve(repoRoot, dirname(file), specifier))
  if (target.startsWith("..")) return null
  let owner = null
  for (const dir of packageDirs) {
    if (target.startsWith(`${dir}${sep}src${sep}`) && (owner === null || dir.length > owner.length)) owner = dir
  }
  return owner === dirname(file) && basename(file) === "PACKAGE.ts" ? null : owner
}

/**
 * Reads one source file's imports, through the shared analysis
 * (`src/ImportAnalysis.ts`): every module specifier it names, and every
 * import the durable-flow rule bans.
 *
 * Banned are another durable runtime's or model SDK's package in any import
 * form (static, type-only, re-export, `import()`, `require()`, an `import()`
 * type); every import of `cloudflare:workflows` and
 * `alchemy/Cloudflare/Workflows`; and a `Workflow*` name imported from
 * `cloudflare:workers`, or one imported from or read off `alchemy/Cloudflare`
 * (with Alchemy's workflow step functions `task`, `sleep`, `sleepUntil` and
 * `waitForEvent`), whether named in the import, accessed on a namespace or
 * default import, or used as a qualified type. A string or comment that
 * merely mentions one is not an import.
 *
 * @param {string} file Repo-relative path, used for the script kind and in each result.
 * @param {string} text The file's source.
 * @returns {{ specifiers: readonly string[]; banned: BannedImport[] }}
 */
export function scanSource(file, text) {
  const analysis = analyze(file, text)
  /** @type {BannedImport[]} */
  const banned = []
  for (const reference of analysis.references) {
    const { specifier } = reference
    const runtime = bannedRuntimeForSpecifier(specifier)
    if (runtime !== null) {
      banned.push({ file, line: reference.line, specifier, usage: `imports "${specifier}"`, runtime })
      continue
    }
    for (const { name, line } of reference.names) {
      const named = bannedRuntimeForName(specifier, name)
      if (named !== null) banned.push({ file, line, specifier, name, usage: `imports ${name} from "${specifier}"`, runtime: named })
    }
    for (const { name, binding, line } of reference.members) {
      const named = bannedRuntimeForName(specifier, name)
      if (named !== null) {
        banned.push({ file, line, specifier, name, usage: `uses ${binding}.${name} from "${specifier}"`, runtime: named })
      }
    }
  }
  return { specifiers: specifiers(analysis), banned: banned.sort((a, b) => a.line - b.line) }
}

/** @type {Map<string, ReturnType<typeof scanSource>>} */
const scans = new Map()

/** Each file is parsed once, whichever check reads it first. @param {string} file */
function scanFile(file) {
  let scan = scans.get(file)
  if (scan === undefined) {
    scan = scanSource(file, readFileSync(join(repoRoot, file), "utf8"))
    scans.set(file, scan)
  }
  return scan
}

/**
 * Splits banned imports into violations and the ones a known entry excuses,
 * and names every known entry that excused nothing.
 *
 * @param {Iterable<BannedImport>} found
 * @param {ReadonlySet<string>} known Entries spelled `file -> specifier`, the file repo-relative with `/`.
 * @returns {{ violations: BannedImport[]; stale: string[] }}
 */
export function partitionBannedImports(found, known) {
  /** @type {BannedImport[]} */
  const violations = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const entry of found) {
    const key = `${entry.file.split(sep).join("/")} -> ${entry.specifier}`
    if (known.has(key)) seen.add(key)
    else violations.push(entry)
  }
  return { violations, stale: [...known].filter((key) => !seen.has(key)) }
}

/**
 * One line of the gate's report for a banned import.
 *
 * @param {BannedImport} entry
 */
export function bannedImportMessage(entry) {
  return `- ${entry.file.split(sep).join("/")}:${entry.line} ${entry.usage} (${entry.runtime}), which is banned: ${durableFlowRule}`
}

/** @param {Record<string, unknown>} manifest @param {string} section */
function dependencyNames(manifest, section) {
  const deps = manifest[section]
  return deps && typeof deps === "object" && !Array.isArray(deps) ? new Set(Object.keys(deps)) : new Set()
}

/**
 * True for a file that only ever runs from a workspace install: tests, configs,
 * package scripts, and build-graph declarations. Such a file may use
 * `devDependencies`; a shipped source file may not.
 *
 * `legacy declaration` is a declaration the build CLI loads with the root install, and
 * no tarball contains one.
 *
 * @param {string} file
 */
function isDevOnlyFile(file) {
  const base = basename(file)
  const parts = file.split(sep)
  return (
    parts.includes("test") ||
    parts.includes("tests") ||
    parts.includes("__tests__") ||
    parts.includes("__type-tests__") ||
    parts.includes("scripts") ||
    base === "legacy declaration" ||
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js")
  )
}

/**
 * The dependency names a package's files may import.
 *
 * The runtime/dev split exists so a published tarball never imports something
 * a consumer's install does not fetch. A `private: true` workspace publishes no
 * tarball and always runs from the workspace install, so for one of those the
 * split carries no meaning and every declared section counts as runtime.
 * Private Effect adapters are pinned build inputs whose emitted imports are
 * relocated into the tarball, so their validated declarations count too.
 * An optional adapter peer is named in `peerDependenciesMeta` alone (#3839),
 * so an optional entry there is a declared peer of any version.
 *
 * @param {WorkspacePackage} pkg
 */
export function dependencySets(pkg) {
  const declared = new Set([
    ...dependencyNames(pkg.manifest, "dependencies"),
    ...dependencyNames(pkg.manifest, "peerDependencies"),
    ...dependencyNames(pkg.manifest, "optionalDependencies"),
    ...Object.entries(pkg.manifest.peerDependenciesMeta ?? {}).filter(([, meta]) => meta?.optional === true).map(([name]) => name),
    ...privateEffectAdapters(pkg.manifest),
  ])
  const dev = new Set([...declared, ...dependencyNames(pkg.manifest, "devDependencies")])
  const runtime = pkg.manifest.private === true ? dev : declared
  return { runtime, dev }
}

function main() {
  const workspacePackages = findWorkspacePackages()
  const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.name))
  const memberDirs = new Set(workspacePackages.map((pkg) => pkg.dir).filter((dir) => dir !== "."))
  /** @type {Array<{ file: string; specifier: string; packageName: string; section: "dependencies" | "devDependencies" }>} */
  const violations = []
  /** @type {Array<{ file: string; specifier: string; packageDir: string }>} */
  const reachThroughs = []
  /** @type {Set<string>} */
  const seenReachThroughs = new Set()
  // The durable-flow ban covers every source file of every scanned package,
  // not only the `src/` tree the declaration rule reads: a Worker entry, a
  // test or a script runs our code too. Nested members are deduplicated.
  /** @type {Set<string>} */
  const banScope = new Set()
  for (const pkg of workspacePackages) {
    /** @type {string[]} */
    const files = []
    if (pkg.dir === ".") files.push(...filesForPackage(pkg, memberDirs).files)
    else collectSourceFiles(pkg.dir, files)
    for (const file of files) banScope.add(file)
  }

  const packageQueue = [...workspacePackages]
  let checkedPackageCount = 0
  while (packageQueue.length > 0) {
    const pkg = packageQueue.shift()
    checkedPackageCount += 1
    const { files, nestedPackageDirs } = filesForPackage(pkg, memberDirs)
    for (const nestedDir of nestedPackageDirs) {
      const nestedPkg = readPackage(nestedDir)
      if (nestedPkg) packageQueue.push(nestedPkg)
    }
    const deps = dependencySets(pkg)
    for (const file of files) {
      const devOnly = isDevOnlyFile(file)
      const allowed = devOnly ? deps.dev : deps.runtime
      const expectedSection = devOnly ? "devDependencies" : "dependencies"
      for (const specifier of scanFile(file).specifiers) {
        const reached = packageSourceReachedBy(file, specifier, memberDirs)
        if (reached !== null && reached !== pkg.dir) {
          const key = `${file.split(sep).join("/")} -> ${specifier}`
          if (knownReachThroughs.has(key)) seenReachThroughs.add(key)
          else reachThroughs.push({ file, specifier, packageDir: reached })
          continue
        }
        const packageName = packageNameForSpecifier(specifier)
        if (!packageName || packageName === pkg.name) continue
        if (allowed.has(packageName)) continue
        violations.push({ file, specifier, packageName, section: expectedSection })
      }
    }
  }

  const staleReachThroughs = [...knownReachThroughs].filter((key) => !seenReachThroughs.has(key))
  const bans = partitionBannedImports(
    [...banScope].sort().flatMap((file) => scanFile(file).banned),
    knownLegacyFixtureImports,
  )
  if (bans.violations.length > 0 || bans.stale.length > 0) {
    console.error("Dependency boundary check failed: banned durable runtimes imported.\n")
    for (const entry of bans.violations) console.error(bannedImportMessage(entry))
    for (const key of bans.stale) {
      console.error(`- knownLegacyFixtureImports entry "${key}" no longer matches an import; remove it from the gate.`)
    }
    console.error("")
    process.exitCode = 1
  }
  if (violations.length > 0 || reachThroughs.length > 0 || staleReachThroughs.length > 0) {
    console.error("Dependency boundary check failed: undeclared imports found.\n")
    for (const violation of violations) {
      const workspaceHint = workspaceNames.has(violation.packageName) ? "workspace dependency" : "dependency"
      console.error(
        `- ${relative(repoRoot, join(repoRoot, violation.file))} imports ${violation.specifier}; ` +
          `declare ${violation.packageName} as a ${workspaceHint} in ${violation.section}.`,
      )
    }
    for (const reach of reachThroughs) {
      const name = readPackage(reach.packageDir)?.name ?? reach.packageDir
      console.error(
        `- ${relative(repoRoot, join(repoRoot, reach.file))} imports ${reach.specifier}, ` +
          `which resolves inside ${reach.packageDir}/src; import ${name} by package name through its export map.`,
      )
    }
    for (const key of staleReachThroughs) {
      console.error(`- knownReachThroughs entry "${key}" no longer matches an import; remove it from the gate.`)
    }
    process.exitCode = 1
  } else if (process.exitCode !== 1) {
    console.log(
      `Dependency boundary check passed for ${checkedPackageCount} package(s); ` +
        `${banScope.size} source files import no banned durable runtime.`,
    )
  }
}

if (isMain(import.meta)) {
  main()
}
