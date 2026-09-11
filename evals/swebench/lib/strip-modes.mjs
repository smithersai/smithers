/**
 * Drops file sections whose only change is the permission bit.
 *
 *   node lib/strip-modes.mjs <patch>
 *
 * Extracting the image's /testbed to the host loses the executable bit, and any
 * command that stages the tree records the changed modes into git's index, so a
 * diff against the base commit is otherwise 1600 mode-only sections around a
 * handful of real edits. A SWE-bench patch is content; mode is noise.
 *
 * `capture-patch.sh` restores the index to the capture base before diffing, so
 * both sides of the diff already carry the image's own modes and this should
 * find nothing to drop. It stays as the check that says so out loud: a wave
 * whose patch loses sections here has a capture that is still reading the
 * host's permission bits.
 */
import { readFileSync, writeFileSync } from "node:fs"

const path = process.argv[2]
const text = readFileSync(path, "utf8")
const sections = text.split(/(?=^diff --git )/m).filter((section) => section.trim().length > 0)
const kept = sections.filter((section) => {
  const body = section.split("\n").slice(1)
  // Rename, copy and similarity headers are changes even with no hunks, so only
  // old/new mode (plus the index line and blanks) makes a section droppable.
  return body.some((line) => !/^(old mode |new mode |index |$)/.test(line))
})
writeFileSync(path, kept.join(""))
console.log(`${path}: ${sections.length} sections -> ${kept.length}`)
