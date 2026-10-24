import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { mkdtemp, readFile, rm, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vibelang from "vibelang-unplugin/esbuild"
import { afterAll, beforeAll, expect, test } from "vitest"

let worker: Miniflare
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "social-preview-"))
  await copyFile("index.html", join(directory, "index.html"))
  await copyFile("public/icon-192.png", join(directory, "icon-192.png"))
  await copyFile("public/social-card.png", join(directory, "social-card.png"))
  // Workspace packages export their source, which can hold `.vibe` modules.
  const bundle = await build({ entryPoints: ["worker/index.ts"], bundle: true, write: false, format: "esm", plugins: [vibelang()] })
  worker = new Miniflare({
    workers: [{ config: {
      name: "site",
      compatibilityDate: "2026-10-19",
      manifest: { mainModule: "index.js", modulesRoot: directory, modules: {
        "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text },
      } },
      env: { ASSETS: { type: "assets" } },
      assets: { directory, hasUserWorker: true, runWorkerFirst: true, notFoundHandling: "single-page-application" },
    } }],
  })
})
afterAll(async () => { await worker?.dispose(); await rm(directory, { recursive: true, force: true }) })

test.each(["https://example.test", "https://self-hosted.example:8443"])("HTML and PNG served by the site Worker on %s", async (origin) => {
  for (const path of ["/", "/app", "/index.html"]) {
    const response = await worker.dispatchFetch(origin + path, { headers: { accept: "text/html", "user-agent": "Twitterbot/1.0" } })
    expect(response.status, await response.clone().text()).toBe(200)
    const html = await response.text()
    const meta = (key: string) => html.match(new RegExp('<meta (?:property|name)="' + key + '" content="([^"]*)"'))?.[1]
    expect(meta("og:title")).toBe("Smithers")
    expect(meta("og:description")).toBe("Automate maintaining your codebase")
    expect(meta("og:image")).toBe(origin + "/social-card.png")
    expect(meta("og:image:width")).toBe("1200")
    expect(meta("og:image:height")).toBe("630")
    expect(meta("og:image:alt")).toBe("Smithers logo and wordmark")
    expect(meta("twitter:card")).toBe("summary_large_image")
    expect(meta("twitter:image")).toBe(meta("og:image"))
    const image = await worker.dispatchFetch(meta("og:image")!)
    expect(image.status).toBe(200)
    expect(image.headers.get("content-type")).toBe("image/png")
    const bytes = Buffer.from(await image.arrayBuffer())
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]))
    expect(bytes.readUInt32BE(16)).toBe(1200)
    expect(bytes.readUInt32BE(20)).toBe(630)
    expect(bytes.length).toBeLessThan(300_000)
  }
})

test("deployment sends asset hits and SPA fallbacks through the same Worker", async () => {
  const deployment = await readFile("alchemy.run.ts", "utf8")
  expect(deployment).toContain('assets: { notFoundHandling: "single-page-application", runWorkerFirst: true }')
})
