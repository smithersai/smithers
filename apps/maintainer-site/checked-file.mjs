import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, realpathSync } from "node:fs"
import { extname, join, resolve, relative, isAbsolute, sep } from "node:path"
import { homedir } from "node:os"
const MAX_FILE = 64 * 1024 * 1024
const FORBIDDEN_SEGMENTS = new Set([".jj", ".git", "node_modules", ".ssh", ".gnupg", ".aws", ".docker", ".kube"])
const SECRET_FILE =
  /^(\.env.*|\.dev\.vars.*|\.npmrc|\.yarnrc.*|\.netrc|\.pypirc|\.htpasswd|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[\w-]+)?|.*\.(pem|key|p12|pfx|jks|keystore|tfstate|tfstate\.backup|tfvars|kdbx|gpg|asc|age)|service[-_]?account.*\.json|.*private[-_]?key.*)$/i
const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".md", ".mdx", ".css", ".html", ".swift", ".zig", ".py", ".sql"])
// Recordings and their chapter lists are named after tests ("auth-token-expires.mp4"), never secret stores.
const MEDIA_EXT = new Set([".gif", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".mp4", ".webm", ".mov", ".m4v"])
// "secret", "token" or "password" in a file name marks a secret store unless the file is source code, docs or media
// (packages/secrets/src/Secret.ts is code; secrets.json is not).
const isSecretFileName = (name) =>
  /secret|token|passw(or)?d/i.test(name) && !CODE_EXT.has(extname(name).toLowerCase()) && !MEDIA_EXT.has(extname(name).toLowerCase()) && !/\.chapters\.json$/i.test(name)

export function refusalFor(segments) {
  for (const [index, segment] of segments.entries()) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return `refused: ${segment}`
    if (SECRET_FILE.test(segment) || (index === segments.length - 1 && isSecretFileName(segment))) return "refused: secret name"
  }
  return null
}

// Opens a checked file under the roots, or returns { status, error }. The caller owns the returned fd.
export function resolveFile(requested, roots) {
  if (typeof requested !== "string" || requested === "" || requested.includes("\0")) return { status: 400, error: "path required" }
  if (process.platform !== "linux" && process.platform !== "darwin")
    return { status: 403, error: "refused: secure file reads unavailable" }
  // Snapshot lazy root paths once for this authorization.
  roots = roots.map(({ path, real }) => ({ path, real }))
  const expanded = requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested
  const candidates = isAbsolute(expanded) ? [resolve(expanded)] : [resolve(roots[0].path, expanded)]
  const target = candidates[0]
  // The path as asked must already sit inside a root, before symlinks are followed.
  const asked = roots.find((root) => target === root.path || target.startsWith(root.path + sep) || target === root.real || target.startsWith(root.real + sep))
  if (!asked) return { status: 403, error: "refused: outside the allowed roots" }
  const askedBase = target.startsWith(asked.real + sep) || target === asked.real ? asked.real : asked.path
  const askedRefusal = refusalFor(relative(askedBase, target).split(sep))
  if (askedRefusal) return { status: 403, error: askedRefusal }
  let real
  try {
    real = realpathSync(target)
  } catch {
    return { status: 404, error: "not found" }
  }
  // Symlinks are followed, so the real file must sit inside a root too.
  const root = roots.find((root) => real === root.real || real.startsWith(root.real + sep))
  if (!root) return { status: 403, error: "refused: outside the allowed roots" }
  const refusal = refusalFor(relative(root.real, real).split(sep))
  if (refusal) return { status: 403, error: refusal }
  let fd
  try {
    // Do not follow a symlink swapped in after realpath, including before the identity check.
    const checked = lstatSync(real)
    if (checked.isSymbolicLink()) return { status: 403, error: "refused: file changed" }
    if (!checked.isFile()) return { status: 404, error: "not a file" }
    if (checked.size > MAX_FILE) return { status: 413, error: "too large" }
    // Darwin's O_NOFOLLOW_ANY rejects a symlink in any component of the canonical path, including
    // the final component; combining it with O_NOFOLLOW returns EINVAL on macOS.
    // Node does not expose O_NOFOLLOW_ANY; its value is defined in Darwin's sys/fcntl.h.
    const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW
    fd = openSync(real, constants.O_RDONLY | noFollow | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.dev !== checked.dev || stat.ino !== checked.ino)
      return { status: 403, error: "refused: file changed" }
    if (stat.size > MAX_FILE) return { status: 413, error: "too large" }
    if (process.platform === "linux") {
      // Inspect the held inode's kernel path, not a pathname that an ancestor swap can redirect.
      const opened = readlinkSync(`/proc/self/fd/${fd}`)
      if (!isAbsolute(opened) || opened.endsWith(" (deleted)"))
        return { status: 403, error: "refused: file changed" }
      const openedRoot = roots.find((root) => opened === root.real || opened.startsWith(root.real + sep))
      if (!openedRoot) return { status: 403, error: "refused: outside the allowed roots" }
      const openedRefusal = refusalFor(relative(openedRoot.real, opened).split(sep))
      if (openedRefusal) return { status: 403, error: openedRefusal }
    }
    const found = { real, fd, stat, size: stat.size }
    fd = undefined
    return found
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR"
      ? { status: 404, error: "not found" }
      : { status: 403, error: "refused: file changed or unreadable" }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

