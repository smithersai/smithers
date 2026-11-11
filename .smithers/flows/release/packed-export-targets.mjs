/** Validate every declared export against the files actually packed for publication. */
import { execFileSync } from "node:child_process"
import { basename } from "node:path"

/**
 * Local credentials that a maintainer's checkout may hold beside authored files.
 * Version control ignores them, so a clean-tree check never sees them, and a
 * broad npm `files` directory rule would ship them. Authored example environment
 * files (the names .gitignore re-admits) remain publishable.
 */
export const isLocalSecret = (path) => {
  const name = path.split(/[\\/]/).pop()
  if (name === ".env" || name.startsWith(".env.")) {
    return !(name === ".env.sample" || name === ".env.template" || name.endsWith(".example"))
  }
  return [".npmrc", ".netrc", ".pypirc"].includes(name) ||
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)
}

/** Null blocks are intentional; every literal leaf in every condition/fallback must ship. */
export const assertExportTargets = (manifest, files, archiveName = "tarball") => {
  let literalTargets = 0
  const fail = (location, target, reason) => {
    throw new Error(`${manifest.name ?? "unnamed package"} ${location} target ${JSON.stringify(target)} ${reason} in ${archiveName}`)
  }
  const visit = (target, location) => {
    if (target === null) return
    if (typeof target === "string") {
      const parts = target.slice(2).split("/")
      if (!target.startsWith("./") || /[\\*\u0000-\u001f\u007f%?#]/.test(target) || parts.some((part) => ["", ".", "..", "node_modules"].includes(part))) {
        fail(location, target, "is not a safe literal package-relative file")
      }
      if (!files.has(`package/${target.slice(2)}`)) fail(location, target, "is missing or is not a regular file")
      literalTargets++
      return
    }
    if (Array.isArray(target)) {
      target.forEach((entry, index) => visit(entry, `${location}[${index}]`))
      return
    }
    if (typeof target === "object" && target !== null) {
      for (const [key, value] of Object.entries(target)) visit(value, `${location}[${JSON.stringify(key)}]`)
      return
    }
    fail(location, target, "is not a string, condition map, array or null block")
  }
  if (manifest.exports === undefined) fail("exports", manifest.exports, "is absent")
  visit(manifest.exports, "exports")
  return literalTargets
}

/** Read only: no archive member is extracted onto the filesystem. Refuses any local credential entry. */
export const assertPackedExportTargets = (tarball) => {
  const options = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000 }
  // Both portable tar listings retain archive order. Pairing names with entry
  // types avoids parsing platform-specific owner/date columns or losing spaces.
  const lines = (text) => text.trimEnd().split("\n")
  const names = lines(execFileSync("tar", ["-tzf", tarball], options))
  const details = lines(execFileSync("tar", ["-tvzf", tarball], options))
  if (names.length !== details.length) throw new Error(`Cannot match tar member names and types in ${basename(tarball)}`)
  const files = new Set(names.filter((_, index) => details[index].startsWith("-")))
  const secrets = names.filter((name) => isLocalSecret(name))
  if (secrets.length > 0) throw new Error(`Local credential files ${secrets.join(", ")} in ${basename(tarball)}`)
  if (!files.has("package/package.json")) throw new Error(`Missing regular package/package.json in ${basename(tarball)}`)
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], options))
  return { name: manifest.name, literalTargets: assertExportTargets(manifest, files, basename(tarball)) }
}
