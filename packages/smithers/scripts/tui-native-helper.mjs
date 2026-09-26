/** Select the native filesystem helper embedded in each compiled TUI. */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const nativeHelper = (target, packageRoot, helpersRoot = process.env.SMITHERS_NATIVE_HELPERS_DIR) => {
  const platform = `${target.os}-${target.arch}${target.musl ? "-musl" : ""}`
  const filename = "smithers-jj-export"
  const candidates = helpersRoot === undefined
    ? [
      join(packageRoot, "flows/platform-node/bin", platform, filename),
      ...(target.os === process.platform && target.arch === process.arch && !target.musl
        ? [process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY, resolve(packageRoot, "../../target/release", filename)]
          .filter((path) => typeof path === "string" && path !== "") : [])
    ]
    : [join(helpersRoot, platform, filename)]
  const path = candidates.find(existsSync)
  if (path === undefined) {
    throw new Error(`Missing native helper for ${platform}. Set SMITHERS_NATIVE_HELPERS_DIR to a directory containing ${platform}/${filename}. Searched: ${candidates.join(", ")}`)
  }
  const bytes = readFileSync(path)
  const valid = bytes.length >= 20 && (target.os === "linux"
    ? bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (target.arch === "arm64" ? 183 : 62)
    : bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (target.arch === "arm64" ? 0x0100000c : 0x01000007))
  if (!valid) throw new Error(`Native helper does not match ${platform}: ${path}`)
  if (target.musl && (bytes.includes(Buffer.from("ld-linux")) || bytes.includes(Buffer.from("ld64.so")))) {
    throw new Error(`Native helper for ${platform} requires glibc: ${path}`)
  }
  return path
}

/** Registration is lazy: help never stages or executes the native helper. */
export const nativeHelperBootstrap = (helper, packageRoot) => `
import __smithersHelper from ${JSON.stringify(helper)} with { type: "file" };
import { registerEmbeddedHelper as __registerSmithersHelper } from ${JSON.stringify(join(packageRoot, "flows/platform-node/src/internal/AtomicFileSystemExecutable.ts"))};
__registerSmithersHelper(__smithersHelper);
`
