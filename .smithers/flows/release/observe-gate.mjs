/**
 * The release gate on `smthrs-observe`, the recorder of what a step reads:
 * the packed `@smthrs/build-cli` holds it for x86_64 and aarch64 Linux, each a
 * static executable for its machine, and each stays executable once npm
 * installs the tarball and once bunx does. Without it a published Smithers
 * build records with strace, at up to three times a step's time.
 *
 * usage: node .smithers/flows/release/observe-gate.mjs <pack-directory>
 *
 * The first-party packages come from the release tarballs through a loopback
 * registry, as in the smithers-ci tarball gate. Exits 1 naming every problem.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import { releaseRegistry } from "./release-registry.mjs"
import { isMain } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"

/** The package that ships the recorder. */
export const recorderPackage = "@smthrs/build-cli"

/** Each binary the package must hold, with the ELF machine it must be built for. */
export const recorderBinaries = [
  { platform: "linux-x64", arch: "x64", path: "native/out/linux-x64/smthrs-observe", machine: 62, machineName: "x86_64" },
  { platform: "linux-arm64", arch: "arm64", path: "native/out/linux-arm64/smthrs-observe", machine: 183, machineName: "aarch64" }
]

/** The ELF machine names this gate can print. */
const machineNames = { 3: "i386", 40: "arm", 62: "x86_64", 183: "aarch64", 243: "riscv" }

/** Each regular file in a gzipped tar archive: its path, mode and bytes. */
export const tarFiles = (archive) => {
  const data = gunzipSync(archive)
  const files = new Map()
  const text = (from, length) => {
    const field = data.subarray(from, from + length)
    const end = field.indexOf(0)
    return field.subarray(0, end === -1 ? field.length : end).toString("utf8")
  }
  let offset = 0
  let longPath
  while (offset + 512 <= data.length) {
    if (data[offset] === 0) break
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8)
    const mode = Number.parseInt(text(offset + 100, 8).trim() || "0", 8)
    const type = String.fromCharCode(data[offset + 156])
    const prefix = text(offset + 345, 155)
    const name = longPath ?? (prefix === "" ? text(offset, 100) : `${prefix}/${text(offset, 100)}`)
    const body = data.subarray(offset + 512, offset + 512 + size)
    longPath = undefined
    if (type === "x") {
      // A pax header: its `path` names the entry after it.
      const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))
      if (found !== null) longPath = found[1]
    } else if (type === "0" || type === "\0") {
      files.set(name, { mode, bytes: Buffer.from(body) })
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

/**
 * What is wrong with `bytes` as a static Linux executable for `machine`, or
 * `undefined`. Static means no program interpreter and no dynamic section: the
 * kernel runs it with nothing of the host's but itself.
 */
export const elfProblem = (bytes, machine) => {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) return "is not an ELF executable"
  if (bytes[4] !== 2 || bytes[5] !== 1) return "is not a 64-bit little-endian ELF file"
  const found = bytes.readUInt16LE(18)
  if (found !== machine) {
    return `is built for ${machineNames[found] ?? `ELF machine ${found}`}, not ${machineNames[machine] ?? machine}`
  }
  if (bytes.readUInt16LE(16) !== 2) return "is not a static executable (ELF type is not EXEC)"
  const headers = Number(bytes.readBigUInt64LE(32))
  const size = bytes.readUInt16LE(54)
  const count = bytes.readUInt16LE(56)
  if (headers + size * count > bytes.length) return "is cut short: its program headers lie past its end"
  for (let index = 0; index < count; index++) {
    const type = bytes.readUInt32LE(headers + index * size)
    if (type === 3) return "is not a static executable: it names a program interpreter"
    if (type === 2) return "is not a static executable: it has a dynamic section"
  }
  return undefined
}

/** What is wrong with the recorder binaries in a packed `@smthrs/build-cli`, one line each. */
export const tarballProblems = (archive) => {
  const files = tarFiles(archive)
  const problems = []
  for (const binary of recorderBinaries) {
    const entry = files.get(`package/${binary.path}`)
    if (entry === undefined) {
      problems.push(`${binary.path} is missing from the packed ${recorderPackage}`)
      continue
    }
    if ((entry.mode & 0o111) === 0) problems.push(`${binary.path} is not executable in the packed ${recorderPackage}`)
    const wrong = elfProblem(entry.bytes, binary.machine)
    if (wrong !== undefined) problems.push(`${binary.path} ${wrong}`)
  }
  return problems
}

/**
 * What is wrong with the recorder binaries of an installed `@smthrs/build-cli`
 * at `packageRoot`. The one built for this machine must also start and print
 * its usage line: where the kernel refuses a file, Node's spawn runs it with
 * `/bin/sh` instead, so only the program's own words prove it ran.
 */
export const installedProblems = (packageRoot, how, host = { platform: process.platform, arch: process.arch }) => {
  const problems = []
  for (const binary of recorderBinaries) {
    const path = join(packageRoot, binary.path)
    let mode
    try {
      mode = statSync(path).mode
    } catch {
      problems.push(`${binary.path} is missing after ${how}`)
      continue
    }
    if ((mode & 0o100) === 0) {
      problems.push(`${binary.path} is not executable after ${how} (mode ${(mode & 0o777).toString(8)})`)
      continue
    }
    if (host.platform === "linux" && host.arch === binary.arch) {
      const started = spawnSync(path, [], { encoding: "utf8", timeout: 30_000 })
      if (!(started.stderr ?? "").startsWith("usage: smthrs-observe")) {
        const said = started.error?.message ?? `exit ${started.status ?? started.signal}: ${(started.stderr ?? "").trim().split("\n")[0]}`
        problems.push(`${binary.path} does not start after ${how}: ${said}`)
      }
    }
  }
  return problems
}

/**
 * Every installed copy of the package under `root`: a directory whose
 * package.json names it. bunx installs a tarball under the command's name
 * (`node_modules/smithers-build`) and keeps another copy in its cache.
 */
export const installedCopies = (root) => {
  const found = []
  const walk = (directory) => {
    try {
      if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === recorderPackage) {
        found.push(directory)
        return
      }
    } catch {
      // No manifest here, or not one of this package: look inside.
    }
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) if (entry.isDirectory()) walk(join(directory, entry.name))
  }
  walk(root)
  return found
}

/** The real path of a program on `PATH`, or `undefined`. */
const onPath = (name) => {
  const found = spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim() ?? ""
  return found === "" ? undefined : realpathSync(found)
}

/**
 * Installs the packed package with npm and with bunx, each in an empty
 * directory with an empty home, and returns what is wrong with each install.
 */
export const installProblems = async (packs) => {
  const entries = JSON.parse(readFileSync(join(packs, "manifest.json"), "utf8"))
  const entry = entries.find((each) => each.name === recorderPackage)
  if (entry === undefined) return [`${recorderPackage} is not in ${join(packs, "manifest.json")}`]
  const tarball = join(packs, entry.filename)
  const bun = onPath("bun")
  if (bun === undefined) return ["bun is not on PATH, so the install by bunx cannot be checked"]
  const registry = await releaseRegistry(packs, entries)
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-observe-gate-")))
  try {
    const home = join(root, "home")
    const temporary = join(root, "tmp")
    const tools = join(root, "tools")
    for (const directory of [home, temporary, tools]) mkdirSync(directory)
    // Bun drops the last path segment of a registry URL with no trailing slash.
    writeFileSync(join(home, ".npmrc"), `@smthrs:registry=${registry.url}/\n`)
    const bin = dirname(process.execPath)
    const programs = { node: process.execPath, npm: join(bin, "npm"), npx: join(bin, "npx"), bun, bunx: bun }
    for (const [name, target] of Object.entries(programs)) symlinkSync(target, join(tools, name))
    const env = { HOME: home, TMPDIR: temporary, PATH: [tools, "/usr/bin", "/bin"].join(delimiter) }
    // Asynchronous: the registry answers from this process while the install runs.
    const run = (cwd, command, args) =>
      new Promise((resolveRun) => {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], timeout: 15 * 60 * 1000, killSignal: "SIGKILL" })
        let stderr = ""
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
        child.once("error", (error) => resolveRun({ status: null, signal: null, stderr: error.message }))
        child.once("close", (status, signal) => resolveRun({ status, signal, stderr }))
      })

    const problems = []
    const npmProject = join(root, "npm")
    mkdirSync(npmProject)
    writeFileSync(join(npmProject, "package.json"), "{\"private\":true}\n")
    const npm = await run(npmProject, "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball])
    if (npm.status !== 0) {
      problems.push(`npm install of ${entry.filename} failed (exit ${npm.status ?? npm.signal}): ${npm.stderr.trim().split("\n").slice(-5).join(" | ")}`)
    } else {
      problems.push(...installedProblems(join(npmProject, "node_modules", recorderPackage), "npm install"))
    }

    const bunProject = join(root, "bunx")
    mkdirSync(bunProject)
    const bunx = await run(bunProject, "bunx", ["--package", tarball, "smithers-build", "--help"])
    const copies = [...installedCopies(temporary), ...installedCopies(home)]
    if (copies.length === 0) {
      problems.push(`bunx installed no copy of ${recorderPackage} (exit ${bunx.status ?? bunx.signal}): ${(bunx.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`)
    }
    for (const copy of copies) problems.push(...installedProblems(copy, "bunx"))
    return problems
  } finally {
    await registry.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Runs the whole gate on a pack directory: the tarball, then both installs. */
export const observeGate = async (packs) => {
  const entries = JSON.parse(readFileSync(join(packs, "manifest.json"), "utf8"))
  const entry = entries.find((each) => each.name === recorderPackage)
  if (entry === undefined) return [`${recorderPackage} is not in ${join(packs, "manifest.json")}`]
  const packed = tarballProblems(readFileSync(join(packs, entry.filename)))
  if (packed.length > 0) return packed
  return installProblems(packs)
}

if (isMain(import.meta)) {
  const [given, ...rest] = process.argv.slice(2)
  if (given === undefined || rest.length > 0) {
    console.error("usage: node .smithers/flows/release/observe-gate.mjs <pack-directory>")
    process.exit(2)
  }
  const problems = await observeGate(resolve(given))
  if (problems.length > 0) {
    console.error(`observe-gate: the packed ${recorderPackage} would record with strace, not smthrs-observe:`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`observe-gate: ${recorderPackage} ships smthrs-observe for ${recorderBinaries.map((each) => each.machineName).join(" and ")}, executable after npm install and bunx.`)
}
