// Stays .ts: Playwright loads fixtures and reporters, and their imports, through its JS/TS loader.
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

/**
 * Chromium evidence without a copy of the bundle per test. A test's file keeps each script's ranges and names its
 * source and source map by content; those are written once per run under `directory`. Every test repeated the whole
 * bundle and map (about 20 MB), so a full run filled a 4-vCPU box's disk (ENOSPC, then crashed pages) before the
 * phone project finished (vl-gatefix, 2026-11-10).
 */
export async function storeScript(directory: string, source: string, sourceMap: unknown): Promise<string> {
  const path = resolve(directory, `${createHash("sha256").update(source).digest("hex")}.json`)
  const present = await stat(path).then(() => true, () => false)
  if (present) return path
  await mkdir(directory, { recursive: true })
  // Three workers may store the same script at once: each writes its own file, and the rename is atomic.
  const temporary = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(temporary, JSON.stringify({ source, sourceMap }))
  await rename(temporary, path)
  return path
}

/** The entries of each test's file, each with its stored source and source map back in place. */
export async function* readEntries(files: Iterable<string>): AsyncGenerator<any> {
  const scripts = new Map<string, Promise<{ source: string; sourceMap: unknown }>>()
  for (const file of files) {
    for (const entry of JSON.parse(await readFile(file, "utf8"))) {
      if (typeof entry.script !== "string") { yield entry; continue }
      let stored = scripts.get(entry.script)
      if (!stored) { stored = readFile(entry.script, "utf8").then((text) => JSON.parse(text)); scripts.set(entry.script, stored) }
      const { script: _, ...ranges } = entry
      const { source, sourceMap } = await stored
      yield { ...ranges, source, sourceMap }
    }
  }
}
