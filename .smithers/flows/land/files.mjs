/** Keep bootstrap writes inside the invoking source tree and replace files atomically. */
import { lstatSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

/** Do not follow a source ancestor into a different workspace; reads may inspect a link itself. */
export function sourcePath(root, path, allowLeafLink = false) {
  const parts = path.split("/")
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || parts.some((part) => !part || part === ".." || part === ".")) throw new Error("Invalid source path")
  for (let index = 1; index <= parts.length; index++) {
    let stat
    try { stat = lstatSync(join(root, ...parts.slice(0, index))) } catch (error) { if (error.code !== "ENOENT") throw error; continue }
    if (stat.isSymbolicLink() && !(allowLeafLink && index === parts.length)) throw new Error(`Source path is a symlink: ${path}`)
  }
  return join(root, path)
}

/** Replacing the inode also protects another tree if the incoming file was hard-linked. */
export function writeSource(root, path, contents) {
  const destination = sourcePath(root, path)
  let mode = 0o644
  try { mode = lstatSync(destination).mode } catch (error) { if (error.code !== "ENOENT") throw error }
  const staging = sourcePath(root, ".jj/agent-writes")
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  const temporary = join(staging, randomUUID())
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode })
    sourcePath(root, path)
    renameSync(temporary, destination)
  } finally { rmSync(temporary, { force: true }) }
}
