/**
 * Fetches one zig release archive, checks it against the sha256 zig publishes
 * for it, and unpacks it to a directory: `node fetch-zig.mjs <url> <sha256>
 * <directory>`. Nothing in the archive runs before its sum matches. The
 * archive unpacks beside the directory and is renamed into place, so a build
 * that runs at the same time finds either nothing or the whole release.
 *
 * `build-observe.mjs` runs it where the zig that builds `smthrs-observe` is not
 * installed. No library chosen: `fetch`, `node:crypto` and the system `tar`,
 * as the release workflow's own zig step uses `curl`, `sha256sum` and `tar`.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const [url, expected, directory] = process.argv.slice(2)
if (directory === undefined) {
  console.error("usage: node fetch-zig.mjs <url> <sha256> <directory>")
  process.exit(2)
}
const fail = (line) => {
  console.error(line)
  process.exit(1)
}
const response = await fetch(url).catch((error) => fail(`${url}: ${error.cause?.message ?? error.message}`))
if (!response.ok) fail(`${url} answered ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const actual = createHash("sha256").update(bytes).digest("hex")
if (actual !== expected) fail(`${url} has sha256 ${actual}, not the ${expected} zig publishes for it`)
mkdirSync(dirname(directory), { recursive: true })
const staging = mkdtempSync(`${directory}.fetching-`)
try {
  const archive = join(staging, "archive.tar.xz")
  writeFileSync(archive, bytes)
  const unpacked = spawnSync("tar", ["-xJf", archive, "-C", staging], { encoding: "utf8" })
  if (unpacked.status !== 0) fail(`tar could not unpack ${url}: ${(unpacked.stderr ?? unpacked.error?.message ?? "").trim()}`)
  // zig's archive holds one directory, named as the archive is.
  try {
    renameSync(join(staging, basename(directory)), directory)
  } catch (error) {
    // Another build unpacked the same release first; its copy is the same bytes.
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}
