/** Native payload checks shared by installed-package smoke and tarball tests. */
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

export const nativeHelperFiles = [
  ["darwin-arm64", "smithers-jj-export"],
  ["darwin-x64", "smithers-jj-export"],
  ["linux-arm64", "smithers-jj-export"],
  ["linux-x64", "smithers-jj-export"],
  ["win32-x64", "smithers-jj-export.exe"]
]

/**
 * Maximum glibc symbol version a dynamically linked Linux native helper may
 * require. Release builds ship static musl binaries (no PT_INTERP and zero
 * glibc needs); this floor guarantees a dynamic fallback can never regress to
 * host-runner glibc versions such as GLIBC_2.39 (#5463).
 */
export const maxLinuxGlibcVersion = "2.28"

const linuxMachines = {
  "linux-x64": { machine: 62, name: "x86_64" },
  "linux-arm64": { machine: 183, name: "aarch64" }
}

const machineNames = { 3: "i386", 40: "arm", 62: "x86_64", 183: "aarch64", 243: "riscv" }

const parseVersionTuple = (text) => text.split(".").map((part) => Number.parseInt(part, 10))

const compareVersionTuples = (left, right) => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a - b
  }
  return 0
}

const readCString = (buffer, offset) => {
  if (offset < 0 || offset >= buffer.length) return ""
  const end = buffer.indexOf(0, offset)
  return buffer.subarray(offset, end === -1 ? buffer.length : end).toString("utf8")
}

/**
 * Inspects a 64-bit little-endian Linux ELF helper binary and returns an error
 * description if its machine mismatches or if any GNU version need exceeds
 * maxGlibcVersion. Static binaries (no PT_INTERP) require no glibc and pass.
 */
export const linuxHelperElfProblem = (bytes, platform, maxGlibcVersion = maxLinuxGlibcVersion) => {
  const expected = linuxMachines[platform]
  if (expected === undefined) return undefined
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) {
    return "is not an ELF executable"
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    return "is not a 64-bit little-endian ELF executable"
  }
  const machine = bytes.readUInt16LE(18)
  if (machine !== expected.machine) {
    return `is built for ${machineNames[machine] ?? `ELF machine ${machine}`}, not ${expected.name}`
  }
  const phoff = Number(bytes.readBigUInt64LE(32))
  const phentsize = bytes.readUInt16LE(54)
  const phnum = bytes.readUInt16LE(56)
  if (phoff + phentsize * phnum > bytes.length) {
    return "is truncated before its ELF program headers end"
  }
  let hasInterp = false
  for (let index = 0; index < phnum; index++) {
    if (bytes.readUInt32LE(phoff + index * phentsize) === 3) {
      hasInterp = true
      break
    }
  }
  if (!hasInterp) return undefined

  const shoff = Number(bytes.readBigUInt64LE(40))
  const shentsize = bytes.readUInt16LE(58)
  const shnum = bytes.readUInt16LE(60)
  if (shoff === 0 || shnum === 0 || shentsize < 64 || shoff + shentsize * shnum > bytes.length) {
    return "is dynamically linked without readable ELF section headers to verify its glibc floor"
  }
  const floor = parseVersionTuple(maxGlibcVersion)
  const offending = new Set()
  for (let index = 0; index < shnum; index++) {
    const header = shoff + index * shentsize
    const type = bytes.readUInt32LE(header + 4)
    if (type !== 0x6ffffffe) continue // SHT_GNU_verneed
    const offset = Number(bytes.readBigUInt64LE(header + 24))
    const size = Number(bytes.readBigUInt64LE(header + 32))
    const link = bytes.readUInt32LE(header + 40)
    if (link >= shnum || offset + size > bytes.length) {
      return "has a malformed SHT_GNU_verneed section"
    }
    const strHeader = shoff + link * shentsize
    const strOffset = Number(bytes.readBigUInt64LE(strHeader + 24))
    const strSize = Number(bytes.readBigUInt64LE(strHeader + 32))
    if (strOffset + strSize > bytes.length) {
      return "has a malformed SHT_GNU_verneed string table"
    }
    const strtab = bytes.subarray(strOffset, strOffset + strSize)
    const sectionEnd = offset + size
    let cursor = offset
    while (cursor + 16 <= sectionEnd) {
      const cnt = bytes.readUInt16LE(cursor + 2)
      const auxRel = bytes.readUInt32LE(cursor + 8)
      const nextRel = bytes.readUInt32LE(cursor + 12)
      let aux = cursor + auxRel
      for (let i = 0; i < cnt && aux + 16 <= sectionEnd; i++) {
        const nameOffset = bytes.readUInt32LE(aux + 8)
        const auxNext = bytes.readUInt32LE(aux + 12)
        const name = readCString(strtab, nameOffset)
        const match = /^GLIBC_(\d+(?:\.\d+)*)$/.exec(name)
        if (match !== null && compareVersionTuples(parseVersionTuple(match[1]), floor) > 0) {
          offending.add(name)
        }
        if (auxNext === 0) break
        aux += auxNext
      }
      if (nextRel === 0) break
      cursor += nextRel
    }
  }
  if (offending.size > 0) {
    const versions = [...offending].sort().join(", ")
    return `requires glibc symbol version(s) above the GLIBC_${maxGlibcVersion} floor: ${versions}`
  }
  return undefined
}

/** An early rehearsal may have no helpers; partial or required bundles must be complete. */
export const verifyPackagedNativeHelpers = async (nativePackage, required = false) => {
  if (!required && !existsSync(join(nativePackage, "bin"))) return false
  for (const [platform, filename] of nativeHelperFiles) {
    const binary = join(nativePackage, "bin", platform, filename)
    const info = await stat(binary)
    if (!info.isFile()) throw new Error(`Installed native helper is not a regular file: ${binary}`)
    if (process.platform !== "win32" && !platform.startsWith("win32") && (info.mode & 0o111) !== 0o111) {
      throw new Error(`Installed native helper is not executable (mode 0${(info.mode & 0o777).toString(8)}): ${binary}`)
    }
    if (platform in linuxMachines) {
      const bytes = await readFile(binary)
      const problem = linuxHelperElfProblem(bytes, platform)
      if (problem !== undefined) {
        throw new Error(`Installed native helper ${binary} ${problem}`)
      }
    }
  }
  return true
}
