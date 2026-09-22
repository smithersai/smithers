import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const runtimeTools = ["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"]

export interface PostgreSQLBundleManifest {
  readonly version: 1
  readonly bin: string
}

const run = (argv: ReadonlyArray<string>): string => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${(result.stderr ?? "").trim()}`)
  }
  return result.stdout ?? ""
}

const filesUnder = (root: string): Array<string> => {
  const files: Array<string> = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  if (existsSync(root)) visit(root)
  return files
}

const isMachO = (path: string): boolean =>
  run(["file", "-b", path]).includes("Mach-O")

const machOFiles = (root: string): Array<string> =>
  [...filesUnder(join(root, "bin")), ...filesUnder(join(root, "lib"))]
    .filter((path) => isMachO(path))

const dependencies = (path: string): Array<string> => {
  const lines = run(["otool", "-L", path]).split("\n").slice(1)
  const idOutput = run(["otool", "-D", path]).split("\n").slice(1)
    .map((line) => line.trim()).filter((line) => line !== "")
  const id = idOutput.length === 1 ? idOutput[0] : undefined
  return lines
    .map((line) => line.trim().replace(/ \(compatibility version.*$/, ""))
    .filter((dependency) => dependency !== "" && dependency !== id)
}

const runtimePaths = (path: string): Array<string> => {
  const lines = run(["otool", "-l", path]).split("\n")
  const paths: Array<string> = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue
    for (let next = index + 1; next < Math.min(lines.length, index + 6); next++) {
      const match = lines[next]?.trim().match(/^path (.+) \(offset /)
      if (match !== null && match !== undefined) {
        paths.push(match[1])
        break
      }
    }
  }
  return paths
}

const isSystemPath = (path: string): boolean =>
  path.startsWith("/System/") || path.startsWith("/usr/lib/")

const isWithin = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

const loaderPath = (from: string, to: string): string => {
  const path = relative(dirname(from), to).split(sep).join("/")
  return `@loader_path/${path}`
}

const sourceDependency = (
  dependency: string,
  sourceFile: string,
  sourceRoot: string
): string | undefined => {
  if (isAbsolute(dependency)) return dependency
  if (dependency.startsWith("@loader_path/")) {
    return resolve(dirname(sourceFile), dependency.slice("@loader_path/".length))
  }
  if (dependency.startsWith("@executable_path/")) {
    return resolve(sourceRoot, "bin", dependency.slice("@executable_path/".length))
  }
  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice("@rpath/".length)
    for (const runtimePath of runtimePaths(sourceFile)) {
      const base = runtimePath.startsWith("@loader_path/")
        ? resolve(dirname(sourceFile), runtimePath.slice("@loader_path/".length))
        : runtimePath === "@loader_path"
        ? dirname(sourceFile)
        : runtimePath.startsWith("@executable_path/")
        ? resolve(sourceRoot, "bin", runtimePath.slice("@executable_path/".length))
        : runtimePath
      if (!isAbsolute(base)) continue
      const candidate = join(base, suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const copyLicense = (library: string, licensesRoot: string): void => {
  let candidate = dirname(library)
  while (candidate !== dirname(candidate) && !existsSync(join(candidate, "INSTALL_RECEIPT.json"))) {
    candidate = dirname(candidate)
  }
  if (!existsSync(join(candidate, "INSTALL_RECEIPT.json"))) return
  const formula = `${basename(dirname(candidate))}-${basename(candidate)}`
  const destination = join(licensesRoot, formula)
  for (const entry of readdirSync(candidate, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(license|copying|notice|copyright)/i.test(entry.name)) continue
    mkdirSync(destination, { recursive: true })
    cpSync(join(candidate, entry.name), join(destination, entry.name))
  }
}

const relocateMacOS = (source: string, destination: string): void => {
  const sourceRoot = realpathSync(source)
  const vendorRoot = join(destination, "lib", "smithers-vendor")
  const licensesRoot = join(destination, "licenses", "smithers-vendor")
  mkdirSync(vendorRoot, { recursive: true })

  const queue = machOFiles(destination)
  const seen = new Set<string>()
  const vendorSources = new Map<string, string>()
  const sourceByTarget = new Map<string, string>()
  for (const file of queue) {
    sourceByTarget.set(file, join(sourceRoot, relative(destination, file)))
  }
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index]
    if (seen.has(file)) continue
    seen.add(file)
    const sourceFile = sourceByTarget.get(file)
    if (sourceFile === undefined || !existsSync(sourceFile)) {
      throw new Error(`Cannot locate the source for bundled PostgreSQL file ${file}`)
    }
    for (const dependency of dependencies(file)) {
      if (isSystemPath(dependency)) continue
      const dependencyPath = sourceDependency(dependency, sourceFile, sourceRoot)
      if (dependencyPath === undefined || !existsSync(dependencyPath)) {
        throw new Error(`PostgreSQL dependency is unavailable: ${dependency} (from ${file})`)
      }
      const dependencySource = realpathSync(dependencyPath)
      let dependencyTarget: string
      if (isWithin(sourceRoot, dependencySource)) {
        const bundledSource = isWithin(sourceRoot, dependencyPath) ? dependencyPath : dependencySource
        dependencyTarget = join(destination, relative(sourceRoot, bundledSource))
      } else {
        const targetName = dependency.startsWith("@loader_path/")
          ? basename(dependencyPath)
          : basename(dependencySource)
        dependencyTarget = join(vendorRoot, targetName)
        const previous = vendorSources.get(dependencyTarget)
        if (previous !== undefined && previous !== dependencySource) {
          throw new Error(`PostgreSQL dependency basename collision: ${previous} and ${dependencySource}`)
        }
        vendorSources.set(dependencyTarget, dependencySource)
        if (!existsSync(dependencyTarget)) {
          cpSync(dependencyPath, dependencyTarget, { dereference: true })
          copyLicense(dependencySource, licensesRoot)
          if (isMachO(dependencyTarget)) {
            queue.push(dependencyTarget)
            sourceByTarget.set(dependencyTarget, dependencyPath)
          }
        }
      }
      if (!existsSync(dependencyTarget)) {
        throw new Error(`Bundled PostgreSQL dependency is missing: ${dependencyTarget}`)
      }
      run(["install_name_tool", "-change", dependency, loaderPath(file, dependencyTarget), file])
    }
    for (const runtimePath of runtimePaths(file)) {
      if (isAbsolute(runtimePath) && !isSystemPath(runtimePath)) {
        run(["install_name_tool", "-delete_rpath", runtimePath, file])
      }
    }
    const id = run(["otool", "-D", file]).split("\n").slice(1)
      .map((line) => line.trim()).filter((line) => line !== "")
    if (id.length === 1 && id[0] !== "" && !id[0].startsWith("@") && !isSystemPath(id[0])) {
      run(["install_name_tool", "-id", `@rpath/${basename(file)}`, file])
    }
    run(["codesign", "--force", "--sign", "-", file])
  }

  for (const file of machOFiles(destination)) {
    for (const dependency of dependencies(file)) {
      if (isSystemPath(dependency)) continue
      if (!dependency.startsWith("@loader_path/")) {
        throw new Error(`Bundled PostgreSQL retains external dependency ${dependency} in ${file}`)
      }
      const resolved = resolve(dirname(file), dependency.slice("@loader_path/".length))
      if (!existsSync(resolved)) {
        throw new Error(`Bundled PostgreSQL dependency is missing: ${dependency} in ${file}`)
      }
    }
    for (const runtimePath of runtimePaths(file)) {
      if (isAbsolute(runtimePath) && !isSystemPath(runtimePath)) {
        throw new Error(`Bundled PostgreSQL retains external runtime path ${runtimePath} in ${file}`)
      }
    }
  }
}

const configuredPath = (pgConfig: string, option: "--bindir" | "--sharedir" | "--pkglibdir"): string => {
  const path = run([pgConfig, option]).trim()
  if (!isAbsolute(path)) throw new Error(`pg_config ${option} returned a non-absolute path: ${path}`)
  return resolve(path)
}

const underSyntheticRoot = (destination: string, absolutePath: string): string =>
  join(destination, "root", absolutePath.replace(/^\/+/, ""))

const copyConfiguredDirectory = (target: string, alias: string): void => {
  if (resolve(target) === resolve(alias)) return
  rmSync(alias, { recursive: true, force: true })
  mkdirSync(dirname(alias), { recursive: true })
  // Electrobun materializes directory symlinks as empty files. PostgreSQL
  // looks up these configured paths at runtime, so ship real directories.
  cpSync(target, alias, { recursive: true, dereference: true })
}

const verifyConfiguredLibraries = (root: string): void => {
  for (const file of filesUnder(root).filter(isMachO)) {
    for (const dependency of dependencies(file)) {
      if (isSystemPath(dependency)) continue
      if (!dependency.startsWith("@loader_path/")) {
        throw new Error(`Bundled PostgreSQL retains external dependency ${dependency} in ${file}`)
      }
      const resolved = resolve(dirname(file), dependency.slice("@loader_path/".length))
      if (!existsSync(resolved)) {
        throw new Error(`Bundled PostgreSQL dependency is missing: ${dependency} in ${file}`)
      }
    }
  }
}

const bundleMacOS = (sourceRoot: string, destination: string): string => {
  const pgConfig = join(sourceRoot, "bin", "pg_config")
  if (!existsSync(pgConfig)) throw new Error("PostgreSQL bundle is missing bin/pg_config.")
  const configuredBin = configuredPath(pgConfig, "--bindir")
  if (realpathSync(configuredBin) !== realpathSync(join(sourceRoot, "bin"))) {
    throw new Error(`PostgreSQL source does not match its configured bin directory: ${configuredBin}`)
  }
  const configuredPrefix = dirname(configuredBin)
  const payload = underSyntheticRoot(destination, configuredPrefix)
  mkdirSync(dirname(payload), { recursive: true })
  cpSync(sourceRoot, payload, { recursive: true, dereference: true })

  relocateMacOS(sourceRoot, payload)
  copyConfiguredDirectory(
    join(payload, "share", "postgresql"),
    underSyntheticRoot(destination, configuredPath(pgConfig, "--sharedir"))
  )
  const configuredLib = underSyntheticRoot(destination, configuredPath(pgConfig, "--pkglibdir"))
  copyConfiguredDirectory(join(payload, "lib", "postgresql"), configuredLib)
  copyConfiguredDirectory(join(payload, "lib", "smithers-vendor"), join(dirname(configuredLib), "smithers-vendor"))
  verifyConfiguredLibraries(dirname(configuredLib))

  const runtimeBin = join(payload, "bin")
  const destinationReal = realpathSync(destination)
  for (const option of ["--bindir", "--sharedir", "--pkglibdir"] as const) {
    const relocated = configuredPath(join(runtimeBin, "pg_config"), option)
    if (!existsSync(relocated) || !isWithin(destinationReal, realpathSync(relocated))) {
      throw new Error(`Relocated pg_config ${option} escapes the PostgreSQL bundle: ${relocated}`)
    }
  }
  return runtimeBin
}

export const bundlePostgres = (source: string, destination: string): void => {
  const sourceRoot = resolve(source)
  for (const tool of runtimeTools) {
    const path = join(sourceRoot, "bin", tool)
    if (!existsSync(path) || !statSync(path).isFile() || (statSync(path).mode & 0o111) === 0) {
      throw new Error(`PostgreSQL bundle is missing bin/${tool}.`)
    }
  }
  const version = run([join(sourceRoot, "bin", "postgres"), "--version"])
  if (!/PostgreSQL\)?\s+18\./.test(version)) {
    throw new Error("SMITHERS_POSTGRES_BUNDLE_DIR must contain PostgreSQL 18.")
  }
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const runtimeBin = process.platform === "darwin"
    ? bundleMacOS(sourceRoot, destination)
    : (() => {
      cpSync(sourceRoot, destination, { recursive: true, dereference: true })
      return join(destination, "bin")
    })()
  const bin = relative(destination, runtimeBin).split(sep).join("/")
  if (bin === "" || bin === ".." || bin.startsWith("../") || isAbsolute(bin)) {
    throw new Error(`PostgreSQL runtime bin path escapes its bundle: ${runtimeBin}`)
  }
  writeFileSync(
    join(destination, "bundle.json"),
    `${JSON.stringify({ version: 1, bin } satisfies PostgreSQLBundleManifest)}\n`,
    { mode: 0o644 }
  )
  for (const tool of runtimeTools) {
    const path = join(runtimeBin, tool)
    if (!existsSync(path) || statSync(path).size === 0 || (statSync(path).mode & 0o111) === 0) {
      throw new Error(`Bundled PostgreSQL tool is unavailable: ${path}`)
    }
  }
}
