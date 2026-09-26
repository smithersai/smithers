#!/usr/bin/env node
/**
 * check-llms.mjs
 *
 * Fails when any llms.txt or llms-full.txt in the repository carries
 * Electrobun scaffold boilerplate. `electrobun init` writes an llms.txt that
 * describes a generic Electrobun app; an agent reading it is told about the
 * wrong project (#1891). Smithers' own bundles never name Electrobun.
 *
 * Usage: node apps/docs/shared/check-llms.mjs [root]
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const skipDirs = new Set(["node_modules", "dist", "build"])
const llmsName = /^llms(-full)?\.txt$/
const boilerplate = /electrobun/i

/** Every llms.txt or llms-full.txt under root that names Electrobun, as root-relative posix paths. */
export const findLlmsBoilerplate = (root) => {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !skipDirs.has(entry.name)) walk(join(dir, entry.name))
      } else if (llmsName.test(entry.name) && boilerplate.test(readFileSync(join(dir, entry.name), "utf8"))) {
        found.push(relative(root, join(dir, entry.name)).split("\\").join("/"))
      }
    }
  }
  walk(root)
  return found.sort()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL("../../..", import.meta.url))
  const found = findLlmsBoilerplate(root)
  for (const path of found) console.error(`electrobun boilerplate: ${path}`)
  if (found.length > 0) {
    console.error(`check-llms: ${found.length} llms file(s) describe Electrobun, not Smithers`)
    process.exit(1)
  }
  console.log("check-llms: clean")
}
