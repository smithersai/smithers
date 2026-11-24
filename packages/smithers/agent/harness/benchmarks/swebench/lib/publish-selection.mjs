/**
 * Publishes a complete matrix selection after every selector has succeeded.
 * The staging directory and destination share a filesystem. Preserve the last
 * complete selection if publication fails; the caller never grades on failure.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

const [, , staging, selected] = process.argv
const current = join(staging, "current")
const previous = join(staging, "previous")
const root = realpathSync(resolve(import.meta.dirname, ".."))
const canonicalSelected = existsSync(selected)
  ? realpathSync(selected)
  : existsSync(dirname(selected))
  ? join(realpathSync(dirname(selected)), basename(selected))
  : resolve(selected)
for (const name of readdirSync(current)) {
  if (!name.endsWith(".rationale.json")) continue
  const path = join(current, name)
  const rationale = JSON.parse(readFileSync(path, "utf8"))
  const target = join(canonicalSelected, `${rationale.instance}.patch`)
  rationale.selectedPatch = target.startsWith(`${root}/`) ? relative(root, target) : target
  writeFileSync(path, `${JSON.stringify(rationale, null, 2)}\n`)
}
const hadSelection = existsSync(selected)
if (hadSelection) renameSync(selected, previous)
try {
  renameSync(current, selected)
} catch (error) {
  if (hadSelection) renameSync(previous, selected)
  throw error
}
