import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { foreignLibraries } from "./system-linkage"

const output = (argv: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`)
  }
  return new TextDecoder().decode(result.stdout).trim()
}

const walk = (path: string, visit: (entry: string) => void): void => {
  visit(path)
  if (!lstatSync(path).isDirectory()) return
  for (const name of readdirSync(path)) walk(join(path, name), visit)
}

export const validateGitBundle = (bundleRoot: string, payloadRoots: ReadonlyArray<string>): void => {
  for (const payloadRoot of payloadRoots) walk(payloadRoot, (entry) => {
    const info = lstatSync(entry)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(entry)
      if (isAbsolute(target)) throw new Error(`Pinned Git contains an absolute symlink: ${entry}`)
      const resolved = resolve(dirname(entry), target)
      const escaped = relative(bundleRoot, resolved)
      if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
        throw new Error(`Pinned Git symlink escapes its bundle: ${entry}`)
      }
      if (!existsSync(resolved)) {
        throw new Error(`Pinned Git symlink is dangling: ${entry} -> ${target}`)
      }
      return
    }
    if (!info.isFile() || (info.mode & 0o111) === 0) return
    if (!output(["/usr/bin/file", "-b", entry]).includes("Mach-O")) return
    const [dependency] = foreignLibraries(entry)
    if (dependency !== undefined) throw new Error(`Pinned Git is not relocatable: ${entry} depends on ${dependency}`)
  })
}
