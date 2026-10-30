import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerRootCleanup } from "./vitest-root-temp.mjs"

// A run owns its scratch and default cache; explicit caches stay with the caller.
// Keep this short: Unix socket paths are bounded.
export function setup(project) {
  registerRootCleanup(project.vitest)
  const directory = mkdtempSync(join(tmpdir(), "st-"))
  // Vitest closes the worker pool before these callbacks, including on cancellation.
  project.vitest.onClose(() => rm(directory, { recursive: true, force: true }))
  const values = {
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(directory, "node-compile-cache"),
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory
  }
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
