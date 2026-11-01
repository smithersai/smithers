import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { recordable } from "./frames.ts"

// The flows e2e/gifs.mjs makes media of: one manifest per test, written beside its recordings (e2e/fixtures.ts
// `writeManifest`).

/** A test's manifest, as much of it as choosing and finding its recordings reads. */
export interface Manifest {
  readonly flow: string
  readonly status?: string
  readonly videos: Array<{ video?: string }>
  readonly [field: string]: unknown
}

/**
 * The manifests under `results`, one per test directory, by flow name: devices.json wins over flow.json in the same
 * directory, since a devices test has no default page. A relative video path is made absolute, beside its manifest.
 * A skipped test's manifest, which an older writer may have left, makes no media: its flow is in `skipped`.
 */
export const readManifests = (results: string): { readonly flows: Array<Manifest>; readonly skipped: Array<string> } => {
  const manifests = readdirSync(results, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith("devices.json") || path.endsWith("flow.json"))
  const byDir = new Map<string, Manifest>()
  for (const path of manifests) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."
    if (byDir.has(dir) && path.endsWith("flow.json")) continue
    const flow = JSON.parse(readFileSync(join(results, path), "utf8")) as Manifest
    for (const video of flow.videos) {
      if (video.video && !video.video.startsWith("/")) video.video = join(results, dir, video.video)
    }
    byDir.set(dir, flow)
  }
  const all = [...byDir.values()].sort((left, right) => left.flow.localeCompare(right.flow))
  return { flows: all.filter((flow) => recordable(flow.status)), skipped: all.filter((flow) => !recordable(flow.status)).map((flow) => flow.flow) }
}
