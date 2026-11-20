/**
 * The observe gate on real tarballs: a package made in a temporary directory,
 * packed by npm, installed by npm and by bunx. Its recorders are real static
 * Linux executables, each a few bytes that exit 0, so the gate's start check
 * runs a program the kernel accepts.
 */
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { elfProblem, installedProblems, observeGate, recorderBinaries, tarballProblems, tarFiles } from "./observe-gate.mjs"
import { packGates } from "./pack-gates.mjs"

const gateProgram = fileURLToPath(new URL("./observe-gate.mjs", import.meta.url))

/** What each program writes to standard error: the first words of smthrs-observe's usage line. */
const usage = Buffer.from("usage: smthrs-observe\n")

/** aarch64 instructions, little-endian. */
const words = (...each) => Buffer.concat(each.map((word) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(word >>> 0)
  return bytes
}))

/** Each machine's program: write the usage line to standard error, then exit 0, through the kernel alone. */
const program = {
  62: Buffer.concat([
    Buffer.from([
      0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1 (write)
      0xbf, 0x02, 0x00, 0x00, 0x00, // mov edi, 2
      0x48, 0x8d, 0x35, 0x10, 0x00, 0x00, 0x00, // lea rsi, [rip + 16]: the line after the code
      0xba, usage.length, 0x00, 0x00, 0x00, // mov edx, length
      0x0f, 0x05, // syscall
      0xb8, 0x3c, 0x00, 0x00, 0x00, // mov eax, 60 (exit)
      0x31, 0xff, // xor edi, edi
      0x0f, 0x05 // syscall
    ]),
    usage
  ]),
  183: Buffer.concat([
    words(
      0xd2800808, // mov x8, #64 (write)
      0xd2800040, // mov x0, #2
      0x100000c1, // adr x1, #24: the line after the code
      0xd2800002 | (usage.length << 5), // mov x2, length
      0xd4000001, // svc #0
      0xd2800ba8, // mov x8, #93 (exit)
      0xd2800000, // mov x0, #0
      0xd4000001 // svc #0
    ),
    usage
  ])
}

/**
 * A static ELF executable for `machine` that prints the usage line and exits
 * 0: one header, one loaded segment. `extra` adds program headers of other types (3 names an
 * interpreter, 2 a dynamic section), which makes it a dynamic one.
 */
const executable = (machine, { extra = [], type = 2 } = {}) => {
  const code = program[machine]
  const headers = 1 + extra.length
  const codeAt = 64 + 56 * headers
  const bytes = Buffer.alloc(codeAt + code.length)
  const base = 0x400000n
  bytes.writeUInt32BE(0x7f454c46, 0)
  bytes[4] = 2 // 64-bit
  bytes[5] = 1 // little-endian
  bytes[6] = 1 // ELF version
  bytes.writeUInt16LE(type, 16)
  bytes.writeUInt16LE(machine, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeBigUInt64LE(base + BigInt(codeAt), 24)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(64, 52)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(headers, 56)
  const header = (index, kind) => {
    const at = 64 + 56 * index
    bytes.writeUInt32LE(kind, at)
    bytes.writeUInt32LE(5, at + 4) // read and execute
    bytes.writeBigUInt64LE(0n, at + 8)
    bytes.writeBigUInt64LE(base, at + 16)
    bytes.writeBigUInt64LE(base, at + 24)
    bytes.writeBigUInt64LE(BigInt(bytes.length), at + 32)
    bytes.writeBigUInt64LE(BigInt(bytes.length), at + 40)
    bytes.writeBigUInt64LE(0x1000n, at + 48)
  }
  header(0, 1)
  extra.forEach((kind, index) => header(index + 1, kind))
  code.copy(bytes, codeAt)
  return bytes
}

const right = () => Object.fromEntries(recorderBinaries.map((binary) => [binary.path, { bytes: executable(binary.machine), mode: 0o755 }]))

/**
 * A pack directory as the release writes one: `manifest.json` and the packed
 * `@smthrs/build-cli`, made by `npm pack` from a package holding `files`.
 */
const packWith = (root, files) => {
  const source = join(root, "source")
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "@smthrs/build-cli",
    version: "0.0.0-gate",
    bin: { "smithers-build": "main.js" },
    files: ["main.js", "native/out/"]
  }))
  writeFileSync(join(source, "main.js"), "#!/usr/bin/env node\nconsole.log(\"smithers-build\")\n", { mode: 0o755 })
  for (const [path, { bytes, mode }] of Object.entries(files)) {
    mkdirSync(join(source, path, ".."), { recursive: true })
    writeFileSync(join(source, path), bytes)
    chmodSync(join(source, path), mode)
  }
  const packs = join(root, "packs")
  mkdirSync(packs)
  const filename = execFileSync("npm", ["pack", "--silent", "--pack-destination", packs], { cwd: source, encoding: "utf8" }).trim()
  writeFileSync(join(packs, "manifest.json"), JSON.stringify([{ name: "@smthrs/build-cli", version: "0.0.0-gate", filename }]))
  return { packs, tarball: join(packs, filename) }
}

const inTemporary = async (body) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-observe-gate-test-")))
  try {
    return await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("pack-gates runs the observe gate right after the pack, before any install smoke", () => {
  assert.deepEqual(packGates.slice(0, 3), [
    ".smithers/flows/release/pack-release.mjs",
    ".smithers/flows/release/observe-gate.mjs",
    ".smithers/flows/release/smoke-release.mjs"
  ])
})

test("a build-cli holding both recorders, static, for their machines and executable, passes installed by npm and by bunx", () =>
  inTemporary(async (root) => {
    const { packs, tarball } = packWith(root, right())
    const files = tarFiles(readFileSync(tarball))
    for (const binary of recorderBinaries) assert.equal(files.get(`package/${binary.path}`).mode & 0o777, 0o755)
    assert.deepEqual(await observeGate(packs), [])
    const passed = spawnSync(process.execPath, [gateProgram, packs], { encoding: "utf8" })
    assert.equal(passed.status, 0, passed.stderr)
    assert.match(passed.stdout, /ships smthrs-observe for x86_64 and aarch64, executable after npm install and bunx/)
  }))

test("the gate fails a pack without the aarch64 recorder, naming the file", () =>
  inTemporary(async (root) => {
    const files = right()
    delete files["native/out/linux-arm64/smthrs-observe"]
    const { packs } = packWith(root, files)
    const failed = spawnSync(process.execPath, [gateProgram, packs], { encoding: "utf8" })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /would record with strace, not smthrs-observe/)
    assert.match(failed.stderr, /native\/out\/linux-arm64\/smthrs-observe is missing from the packed @smthrs\/build-cli/)
  }))

test("the gate fails a pack with neither recorder", () =>
  inTemporary(async (root) => {
    const { packs } = packWith(root, {})
    assert.deepEqual(await observeGate(packs), [
      "native/out/linux-x64/smthrs-observe is missing from the packed @smthrs/build-cli",
      "native/out/linux-arm64/smthrs-observe is missing from the packed @smthrs/build-cli"
    ])
  }))

test("the gate fails a recorder built for the other machine, a dynamic one, and one packed without its execute bit", () =>
  inTemporary(async (root) => {
    const swapped = packWith(join(root, "swapped"), {
      "native/out/linux-x64/smthrs-observe": { bytes: executable(183), mode: 0o755 },
      "native/out/linux-arm64/smthrs-observe": { bytes: executable(62), mode: 0o755 }
    })
    assert.deepEqual(tarballProblems(readFileSync(swapped.tarball)), [
      "native/out/linux-x64/smthrs-observe is built for aarch64, not x86_64",
      "native/out/linux-arm64/smthrs-observe is built for x86_64, not aarch64"
    ])
    const dynamic = packWith(join(root, "dynamic"), {
      ...right(),
      "native/out/linux-x64/smthrs-observe": { bytes: executable(62, { extra: [3] }), mode: 0o755 },
      "native/out/linux-arm64/smthrs-observe": { bytes: executable(183, { extra: [2] }), mode: 0o755 }
    })
    assert.deepEqual(tarballProblems(readFileSync(dynamic.tarball)), [
      "native/out/linux-x64/smthrs-observe is not a static executable: it names a program interpreter",
      "native/out/linux-arm64/smthrs-observe is not a static executable: it has a dynamic section"
    ])
    const plain = packWith(join(root, "plain"), {
      ...right(),
      "native/out/linux-x64/smthrs-observe": { bytes: executable(62), mode: 0o644 }
    })
    assert.deepEqual(await observeGate(plain.packs), [
      "native/out/linux-x64/smthrs-observe is not executable in the packed @smthrs/build-cli"
    ])
  }))

test("an ELF reader refuses what is not a 64-bit little-endian static executable", () => {
  assert.equal(elfProblem(Buffer.from("#!/bin/sh\nexit 0\n".padEnd(64)), 62), "is not an ELF executable")
  const thirtyTwo = executable(62)
  thirtyTwo[4] = 1
  assert.equal(elfProblem(thirtyTwo, 62), "is not a 64-bit little-endian ELF file")
  assert.equal(elfProblem(executable(62, { type: 3 }), 62), "is not a static executable (ELF type is not EXEC)")
  const riscv = executable(62)
  riscv.writeUInt16LE(243, 18)
  assert.equal(elfProblem(riscv, 62), "is built for riscv, not x86_64")
  riscv.writeUInt16LE(9999, 18)
  assert.equal(elfProblem(riscv, 62), "is built for ELF machine 9999, not x86_64")
  const cut = executable(62)
  cut.writeUInt16LE(40, 56)
  assert.equal(elfProblem(cut, 62), "is cut short: its program headers lie past its end")
})

test("an installed recorder that lost its execute bit, or that the kernel will not start, fails the gate", () =>
  inTemporary(async (root) => {
    const { tarball } = packWith(root, right())
    const project = join(root, "project")
    mkdirSync(project)
    writeFileSync(join(project, "package.json"), "{\"private\":true}\n")
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", tarball], { cwd: project, stdio: "pipe" })
    const installed = join(project, "node_modules/@smthrs/build-cli")
    assert.deepEqual(installedProblems(installed, "npm install"), [])
    chmodSync(join(installed, "native/out/linux-arm64/smthrs-observe"), 0o644)
    assert.deepEqual(installedProblems(installed, "npm install"), [
      "native/out/linux-arm64/smthrs-observe is not executable after npm install (mode 644)"
    ])
    // A file the kernel cannot execute: Node hands it to /bin/sh, and the start check sees no usage line.
    const host = process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")
    if (host) {
      const own = recorderBinaries.find((binary) => binary.arch === process.arch).path
      chmodSync(join(installed, "native/out/linux-arm64/smthrs-observe"), 0o755)
      writeFileSync(join(installed, own), "not a program")
      const problems = installedProblems(installed, "npm install")
      assert.equal(problems.length, 1, problems.join("\n"))
      assert.match(problems[0], new RegExp(`^${own.replaceAll("/", "\\/")} does not start after npm install: exit 127: .*not found$`))
    }
    rmSync(join(installed, "native/out/linux-x64/smthrs-observe"))
    assert.equal(installedProblems(installed, "npm install")[0], "native/out/linux-x64/smthrs-observe is missing after npm install")
  }))

test("a pack directory without build-cli fails the gate", () =>
  inTemporary(async (root) => {
    writeFileSync(join(root, "manifest.json"), "[]")
    assert.deepEqual(await observeGate(root), [`@smthrs/build-cli is not in ${join(root, "manifest.json")}`])
  }))
