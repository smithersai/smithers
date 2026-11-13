/** Record the installed CLI executable a runner actually starts. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const hash = bytes => createHash("sha256").update(bytes).digest("hex")

const executable = manifest => {
  if (manifest.name !== "@smthrs/cli") throw new Error("Expected an @smthrs/cli package")
  const bin = manifest.bin
  const name = bin?.smthrs ? "smthrs" : Object.keys(bin ?? {})[0]
  if (!name || typeof bin[name] !== "string") throw new Error("CLI package declares no executable")
  return { name: manifest.name, version: manifest.version, executable: name, bin: bin[name].replace(/^\.\//, "") }
}

export const packedIdentity = tarball => {
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }))
  const identity = executable(manifest)
  return { ...identity, sha256: hash(execFileSync("tar", ["-xOf", tarball, "package/" + identity.bin])) }
}

export const installedIdentity = directory => {
  const identity = executable(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")))
  return { ...identity, sha256: hash(readFileSync(join(directory, identity.bin))) }
}

// npm itself also inherits the preload. Record only the CLI's declared bin,
// never the package manager or an unrelated subprocess.
if (process.env.MATRIX_IDENTITY_FILE && process.argv[1] && existsSync(process.argv[1])) {
  const entry = realpathSync(process.argv[1])
  let directory = dirname(entry)
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, "package.json")
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      if (manifest.name === "@smthrs/cli") {
        const identity = installedIdentity(directory)
        if (resolve(directory, identity.bin) === entry) {
          writeFileSync(process.env.MATRIX_IDENTITY_FILE, JSON.stringify(identity) + "\n")
        }
        break
      }
    }
    directory = dirname(directory)
  }
}
