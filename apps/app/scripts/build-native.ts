import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { bundlePostgres } from "./bundle-postgres"

const appDir = resolve(import.meta.dir, "..")
const root = resolve(appDir, "..", "..")
const nativeDir = join(appDir, ".native")
const configuredCargoTarget = process.env.CARGO_TARGET_DIR?.trim()
const cargoTargetDir = configuredCargoTarget
  ? resolve(root, configuredCargoTarget)
  : join(root, "target")
const configuredNode = process.env.SMITHERS_NODE_BINARY?.trim()
const discoveredNode = configuredNode === undefined || configuredNode === ""
  ? Bun.which("node")
  : isAbsolute(configuredNode) ? configuredNode : Bun.which(configuredNode)
if (discoveredNode === null || discoveredNode === undefined) {
  throw new Error("SMITHERS_NODE_BINARY must name a build-time Node 22 executable.")
}
const nodeBinary = realpathSync(discoveredNode)
const nodeVersion = Bun.spawnSync([nodeBinary, "--version"], { stdout: "pipe", stderr: "pipe" })
if (nodeVersion.exitCode !== 0 || !/^v22\./.test(new TextDecoder().decode(nodeVersion.stdout).trim())) {
  throw new Error("SMITHERS_NODE_BINARY must name Node 22.")
}
const corepackBinary = join(dirname(nodeBinary), "corepack")
if (!existsSync(corepackBinary) || (statSync(corepackBinary).mode & 0o111) === 0) {
  throw new Error(`The selected Node 22 distribution has no executable corepack: ${corepackBinary}`)
}
const nodeLicense = join(dirname(dirname(nodeBinary)), "LICENSE")
if (!existsSync(nodeLicense)) throw new Error(`Node 22 license is unavailable: ${nodeLicense}`)
const nodeEnvironment = {
  PATH: process.env.PATH === undefined || process.env.PATH === ""
    ? dirname(nodeBinary)
    : `${dirname(nodeBinary)}${delimiter}${process.env.PATH}`
}

const run = async (
  label: string,
  argv: ReadonlyArray<string>,
  cwd = root,
  extraEnv: Readonly<Record<string, string>> = {}
): Promise<void> => {
  console.log(`[build-native] ${label}: ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], {
    cwd,
    env: {
      ...process.env,
      CARGO_BUILD_JOBS: "2",
      GOMAXPROCS: "2",
      ...extraEnv
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}.`)
}

const postgresBundle = process.env.SMITHERS_POSTGRES_BUNDLE_DIR?.trim()
if (!postgresBundle) {
  throw new Error(
    "SMITHERS_POSTGRES_BUNDLE_DIR must name a build-time PostgreSQL 18 distribution; native launch never downloads binaries."
  )
}
const postgresBin = join(postgresBundle, "bin")
for (const tool of ["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"]) {
  const path = join(postgresBin, tool)
  if (!existsSync(path) || (statSync(path).mode & 0o111) === 0) {
    throw new Error(`PostgreSQL bundle is missing bin/${tool}.`)
  }
}
const version = Bun.spawnSync([join(postgresBin, "postgres"), "--version"], {
  stdout: "pipe",
  stderr: "pipe"
})
if (
  version.exitCode !== 0 ||
  !/PostgreSQL\)?\s+18\./.test(new TextDecoder().decode(version.stdout))
) {
  throw new Error("SMITHERS_POSTGRES_BUNDLE_DIR must contain PostgreSQL 18.")
}
if (!existsSync(join(root, "crates", "smithers-ffi", "Cargo.toml"))) {
  throw new Error("crates/smithers-ffi is required for the native distribution.")
}

rmSync(nativeDir, { recursive: true, force: true })
mkdirSync(join(nativeDir, "bin"), { recursive: true })
mkdirSync(join(nativeDir, "licenses"), { recursive: true })
const wasm = join(root, "packages", "smithers", "flows", "jj", "wasm", "flows_jj.wasm")
if (!existsSync(wasm) || statSync(wasm).size === 0) {
  throw new Error("The canonical Rust 1.89 flows_jj.wasm artifact is missing.")
}
await run("Rust 1.89 toolchain", ["rustup", "run", "1.89.0", "rustc", "--version"])
if (process.platform === "linux" && process.arch === "x64") {
  await run(
    "canonical jj WebAssembly",
    ["node", "crates/flows-jj/build-wasm.mjs", "--verify"],
    root,
    { RUSTUP_TOOLCHAIN: "1.89.0" }
  )
} else {
  console.log("[build-native] canonical jj WebAssembly: using verified linux/amd64 artifact")
}
await run(
  "native FFI (Rust 1.98)",
  ["cargo", "+1.98.0", "build", "--locked", "--release", "--package", "smithers-ffi"]
)
await run(
  "Go backend",
  ["go", "build", "-trimpath", "-o", join(nativeDir, "bin", "smithers-backend"), "./apps/backend"]
)
await run("Node buildchain", [nodeBinary, "--version"], root, nodeEnvironment)
await run("pinned pnpm buildchain", [corepackBinary, "pnpm", "--version"], root, nodeEnvironment)
const codingHost = join(nativeDir, "bin", "smithers-coding-host")
await run(
  "canonical coding host",
  [
    nodeBinary,
    "flows/coding/build.mjs",
    codingHost
  ],
  root,
  nodeEnvironment
)
const librarianHost = join(nativeDir, "bin", "smithers-librarian-host")
await run(
  "canonical librarian host",
  [nodeBinary, "flows/librarian/build.mjs", librarianHost],
  root,
  nodeEnvironment
)
await run(
  "Flow host manifest",
  [
    nodeBinary,
    "distribution/flow-host-manifest.mjs",
    join(nativeDir, "bin", "flow-hosts.json"),
    codingHost,
    librarianHost
  ],
  root,
  nodeEnvironment
)

// Canonical host artifacts are executable ESM with `#!/usr/bin/env node`.
// Ship the validated Node 22 build runtime and its license. An installed app
// never depends on Homebrew, nvm, or a runtime download.
const hostRuntime = join(nativeDir, "bin", "node")
cpSync(nodeBinary, hostRuntime)
cpSync(nodeLicense, join(nativeDir, "licenses", "node-LICENSE"))
await run("packaged coding host", [hostRuntime, codingHost, "--help"])
await run("packaged librarian host", [hostRuntime, librarianHost, "--help"])

const ffiName = process.platform === "darwin"
  ? "libsmithers_ffi.dylib"
  : process.platform === "linux"
  ? "libsmithers_ffi.so"
  : "smithers_ffi.dll"
const ffi = join(cargoTargetDir, "release", ffiName)
if (!existsSync(ffi)) {
  throw new Error(`Rust 1.98 build did not produce ${basename(ffi)}.`)
}
const jjExport = join(cargoTargetDir, "release", "smithers-jj-export")
if (!existsSync(jjExport)) {
  throw new Error("Rust 1.98 build did not produce smithers-jj-export.")
}
cpSync(ffi, join(nativeDir, "bin", ffiName))
cpSync(jjExport, join(nativeDir, "bin", "smithers-jj-export"))
bundlePostgres(postgresBundle, join(nativeDir, "postgres"))

await run("web bundle", [corepackBinary, "pnpm", "run", "build:web"], appDir, nodeEnvironment)
await run(
  "stable Electrobun package",
  [corepackBinary, "pnpm", "exec", "electrobun", "build", "--env=stable"],
  appDir,
  nodeEnvironment
)
