/*
 * `pnpm showcase [id...]`: record the showcase cases (all, or the named ones)
 * through playwright.showcase.config.ts, turn each video into a GIF, and
 * rebuild <out>/index.html from every recorded case plus the coverage.
 *
 *   --out <dir>   output directory (default apps/app/showcase-out, gitignored)
 *   --page        only rebuild the page from what is already recorded
 *
 * Needs ffmpeg (video to frames) and gifski (frames to GIF), e.g.
 * `brew install ffmpeg gifski`; without gifski, ffmpeg's palette filter is
 * used. SMITHERS_SKIP_SPA_BUILD=1 reuses dist/.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { loadCases } from "../e2e/showcase/cases"
import { coverage, readRecords } from "../e2e/showcase/coverage"
import { renderPage } from "../e2e/showcase/page"

const APP = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  args.splice(index, 2)
  return value
}
const out = resolve(flag("--out") ?? process.env.SHOWCASE_OUT ?? join(APP, "showcase-out"))
const pageOnly = args.includes("--page")
const unknownFlags = args.filter(arg => arg.startsWith("-") && arg !== "--page")
const ids = args.filter(arg => !arg.startsWith("-"))
if (unknownFlags.length > 0 || (pageOnly && ids.length > 0)) {
  console.error("usage: pnpm showcase [id...] [--out <dir>] | pnpm showcase --page [--out <dir>]")
  process.exit(2)
}

const GIF_WIDTH = 960
const GIF_FPS = 10

const which = (tool: string): boolean => spawnSync("which", [tool], { stdio: "ignore" }).status === 0
const run = (command: string, argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): number =>
  spawnSync(command, argv, { cwd: APP, stdio: "inherit", env }).status ?? 1

const toGif = (video: string, gif: string, trimStart: number): void => {
  const frames = mkdtempSync(join(tmpdir(), "showcase-frames-"))
  try {
    const scale = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`
    if (which("gifski")) {
      if (run("ffmpeg", ["-v", "error", "-y", "-ss", String(trimStart), "-i", video, "-vf", scale, join(frames, "f%05d.png")]) !== 0) throw new Error(`ffmpeg failed on ${video}`)
      const pngs = readdirSync(frames).filter(file => file.endsWith(".png")).sort().map(file => join(frames, file))
      // gifski's default motion quality leaves ghosts of earlier frames on static regions.
      if (run("gifski", ["--quiet", "--fps", String(GIF_FPS), "--width", String(GIF_WIDTH), "--quality", "90", "--motion-quality", "100", "-o", gif, ...pngs]) !== 0) throw new Error(`gifski failed on ${video}`)
    } else {
      const filter = `${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
      if (run("ffmpeg", ["-v", "error", "-y", "-ss", String(trimStart), "-i", video, "-filter_complex", filter, gif]) !== 0) throw new Error(`ffmpeg failed on ${video}`)
    }
  } finally {
    rmSync(frames, { recursive: true, force: true })
  }
}

const known = loadCases().map(definition => definition.id)
const unknown = ids.filter(id => !known.includes(id))
if (unknown.length > 0) {
  console.error(`no such case: ${unknown.join(", ")} (cases: ${known.join(", ")})`)
  process.exit(2)
}
for (const dir of ["cases", "videos", "gifs"]) mkdirSync(join(out, dir), { recursive: true })

let failed = false
if (!pageOnly) {
  if (!which("ffmpeg")) {
    console.error("the showcase needs ffmpeg (and ideally gifski): brew install ffmpeg gifski")
    process.exit(2)
  }
  const targets = ids.length > 0 ? ids : known
  // A case that fails must not leave its previous GIF on the page.
  for (const id of targets) {
    for (const stale of [join(out, "cases", `${id}.json`), join(out, "videos", `${id}.webm`), join(out, "gifs", `${id}.gif`)]) rmSync(stale, { force: true })
  }
  rmSync(join(out, "videos", ".raw"), { recursive: true, force: true })
  const grep = ids.length > 0 ? ["--grep", `showcase:(${ids.join("|")})$`] : []
  const status = run("pnpm", ["exec", "playwright", "test", "--config", "playwright.showcase.config.ts", ...grep], {
    ...process.env,
    SHOWCASE_RECORD: out
  })
  failed = status !== 0
  for (const id of targets) {
    const record = readRecords(out).find(candidate => candidate.id === id)
    const video = join(out, "videos", `${id}.webm`)
    if (record === undefined || !existsSync(video)) {
      console.error(`showcase:${id} did not record`)
      failed = true
      continue
    }
    const gif = join(out, "gifs", `${id}.gif`)
    try {
      toGif(video, gif, record.trimStart)
      console.log(`${gif} ${(statSync(gif).size / 1e6).toFixed(1)} MB`)
    } catch (error) {
      // A case without its GIF leaves the page rather than showing an older one.
      rmSync(gif, { force: true })
      console.error(`showcase:${id}: ${error instanceof Error ? error.message : String(error)}`)
      failed = true
    }
  }
  rmSync(join(out, "videos", ".raw"), { recursive: true, force: true })
}

// Records of cases that no longer exist leave the page.
for (const record of readRecords(out)) {
  if (!known.includes(record.id)) {
    for (const stale of [join(out, "cases", `${record.id}.json`), join(out, "videos", `${record.id}.webm`), join(out, "gifs", `${record.id}.gif`)]) rmSync(stale, { force: true })
  }
}
const records = [...readRecords(out)].filter(record => existsSync(join(out, "gifs", `${record.id}.gif`))).sort((a, b) => a.order - b.order)
const result = coverage(records)
if (result.unknown.length > 0) {
  console.error(`cases name flows the registry does not declare: ${result.unknown.join(", ")}`)
  failed = true
}
const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: APP, encoding: "utf8" }).stdout.trim() || "unknown"
const dirty = spawnSync("git", ["status", "--porcelain", "--", "."], { cwd: APP, encoding: "utf8" }).stdout.trim() !== ""
writeFileSync(join(out, "coverage.json"), `${JSON.stringify(result, null, 2)}\n`)
writeFileSync(join(out, "index.html"), renderPage({
  records,
  coverage: result,
  revision: dirty ? `${revision}+local` : revision,
  generatedAt: new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16)
}))
console.log(`${join(out, "index.html")}: ${records.length} cases; flows ${result.counts.recorded} recorded, ${result.counts.unrecorded} unrecorded, ${result.counts.unavailable} unavailable`)
process.exit(failed ? 1 : 0)
