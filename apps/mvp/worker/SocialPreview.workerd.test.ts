import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vibelang from "vibelang-unplugin/esbuild"
import { afterAll, beforeAll, expect, test } from "vitest"
import { siteAssets } from "../infra/SiteAssets.ts"

let worker: Miniflare
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "social-preview-"))
  await mkdir(join(directory, "assets"))
  await writeFile(join(directory, "assets/current-12345678.js"), "export default 1")
  await writeFile(join(directory, "assets/current-12345678.css"), "body{color:red}")
  await copyFile("public/_headers", join(directory, "_headers"))
  await copyFile("index.html", join(directory, "index.html"))
  await copyFile("public/icon-192.png", join(directory, "icon-192.png"))
  await copyFile("public/social-card.png", join(directory, "social-card.png"))
  // Workspace packages export their source, which can hold `.vibe` modules.
  const bundle = await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    conditions: ["workerd"],
    plugins: [vibelang()],
  })
  worker = new Miniflare({
    workers: [{ config: {
      name: "site",
      compatibilityDate: "2026-10-19",
      manifest: { mainModule: "index.js", modulesRoot: directory, modules: {
        "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text },
      } },
      env: { ASSETS: { type: "assets" } },
      assets: { directory, hasUserWorker: true, ...siteAssets },
    } }],
  })
})
afterAll(async () => { await worker?.dispose(); await rm(directory, { recursive: true, force: true }) })

test.each(["https://example.test", "https://self-hosted.example:8443"])("HTML and PNG served by the site Worker on %s", async (origin) => {
  for (const path of ["/", "/app", "/index.html"]) {
    const response = await worker.dispatchFetch(origin + path, { headers: { accept: "text/html", "user-agent": "Twitterbot/1.0" } })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get("cache-control") ?? "").not.toContain("immutable")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
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
    expect(image.headers.get("cache-control")).toBe("public, max-age=86400, stale-while-revalidate=604800")
    const bytes = Buffer.from(await image.arrayBuffer())
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(bytes.readUInt32BE(16)).toBe(1200)
    expect(bytes.readUInt32BE(20)).toBe(630)
    expect(bytes.length).toBeLessThan(300_000)
  }
})

test("current hashed JS and CSS keep immutable caching while retired assets receive a non-immutable 404", async () => {
  const scriptHeaders = { accept: "*/*", "sec-fetch-dest": "script", "sec-fetch-mode": "cors" }
  const currentJs = await worker.dispatchFetch("https://example.test/assets/current-12345678.js", { headers: scriptHeaders })
  expect(currentJs.status).toBe(200)
  expect(currentJs.headers.get("content-type")).toContain("javascript")
  expect(currentJs.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(await currentJs.text()).toBe("export default 1")

  const styleHeaders = { accept: "text/css,*/*;q=0.1", "sec-fetch-dest": "style", "sec-fetch-mode": "no-cors" }
  const currentCss = await worker.dispatchFetch("https://example.test/assets/current-12345678.css", { headers: styleHeaders })
  expect(currentCss.status).toBe(200)
  expect(currentCss.headers.get("content-type")).toContain("text/css")
  expect(currentCss.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(await currentCss.text()).toBe("body{color:red}")

  const missingCases: ReadonlyArray<[string, string, Record<string, string>]> = [
    ["GET", "/assets/retired-12345678.js", scriptHeaders],
    ["HEAD", "/assets/retired-12345678.js", scriptHeaders],
    ["POST", "/assets/retired-12345678.js", scriptHeaders],
    ["GET", "/assets/retired-12345678.js", { accept: "text/html", "sec-fetch-dest": "document" }],
    ["GET", "/assets/retired-12345678.css", styleHeaders],
    ["HEAD", "/assets/retired-12345678.css", styleHeaders],
    ["GET", "/%61ssets/retired-12345678.js", scriptHeaders],
    ["GET", "/workbox-retired123.js", scriptHeaders],
  ]
  for (const [method, path, headers] of missingCases) {
    const missing = await worker.dispatchFetch(`https://example.test${path}`, { method, headers })
    expect(missing.status, `${method} ${path}`).toBe(404)
    expect(missing.headers.get("cache-control"), `${method} ${path}`).toBe("no-store")
    expect(missing.headers.get("content-type") ?? "", `${method} ${path}`).not.toContain("text/html")
    expect(await missing.text(), `${method} ${path}`).toBe("")
  }
})

test("app deep links serve origin-aware 200 HTML and unknown page routes retain 404 recovery HTML", async () => {
  const htmlHeaders = { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }
  for (const path of ["/app", "/evmts/zevm/pull/63", "/owner/repo/blob/main/src/file.ts", "/owner/my.repo", "/owner/repo/blob/main/app.js"]) {
    const response = await worker.dispatchFetch(`https://example.test${path}`, { headers: htmlHeaders })
    expect(response.status, path).toBe(200)
    expect(response.headers.get("content-type"), path).toContain("text/html")
    expect(response.headers.get("x-robots-tag"), path).toBeNull()
    expect(response.headers.get("cache-control") ?? "", path).not.toContain("immutable")
    expect(response.headers.get("x-frame-options"), path).toBe("DENY")
    const html = await response.text()
    expect(html, path).toContain("https://example.test/social-card.png")
    expect(html, path).not.toContain("__SMITHERS_ORIGIN__")
  }

  const headApp = await worker.dispatchFetch("https://example.test/app", { method: "HEAD", headers: htmlHeaders })
  expect(headApp.status).toBe(200)
  expect(headApp.headers.get("content-type")).toContain("text/html")
  expect(await headApp.text()).toBe("")

  for (const path of ["/_definitely-missing-page", "/app/unknown", "/owner/repo/issues/0", "/api"]) {
    const response = await worker.dispatchFetch(`https://example.test${path}`, { headers: htmlHeaders })
    expect(response.status, path).toBe(404)
    expect(response.headers.get("content-type"), path).toContain("text/html")
    expect(response.headers.get("x-robots-tag"), path).toBe("noindex")
    expect(response.headers.get("cache-control") ?? "", path).not.toContain("immutable")
    expect(response.headers.get("x-frame-options"), path).toBe("DENY")
    const html = await response.text()
    expect(html, path).toContain("https://example.test/social-card.png")
    expect(html, path).not.toContain("__SMITHERS_ORIGIN__")
  }

  const headMissing = await worker.dispatchFetch("https://example.test/_definitely-missing-page", { method: "HEAD", headers: htmlHeaders })
  expect(headMissing.status).toBe(404)
  expect(headMissing.headers.get("x-robots-tag")).toBe("noindex")
  expect(await headMissing.text()).toBe("")

  const health = await worker.dispatchFetch("https://example.test/api/health")
  expect(health.status).toBe(200)
  expect(health.headers.get("cache-control")).toBe("no-store")
  expect(await health.json()).toEqual({ ok: true, service: "smithers" })
})

test("deployment wires siteAssets with notFoundHandling none and worker-first document/API entrypoints", async () => {
  const deployment = await readFile("alchemy.run.ts", "utf8")
  expect(deployment).toContain('import { siteAssets } from "./infra/SiteAssets.ts"')
  expect(deployment).toContain("assets: siteAssets,")
  expect(siteAssets.notFoundHandling).toBe("none")
  expect(siteAssets.runWorkerFirst).toEqual(["/", "/index.html", "/api/*"])
})
