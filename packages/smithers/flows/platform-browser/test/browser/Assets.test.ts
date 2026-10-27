/**
 * A dedicated worker reads the real browser's precache after its transport is
 * offline. No service worker or network interception supplies the bytes.
 */
import { build } from "esbuild"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, webkit } from "playwright"
import { afterAll, beforeAll, expect, test } from "vitest"

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
let server: Server
let origin: string
beforeAll(async () => {
  const result = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./app/asset-worker.ts", import.meta.url))],
    format: "esm",
    platform: "browser",
    write: false
  })
  const script = result.outputFiles[0]!.contents
  server = createServer((request, response) => {
    if (request.url === "/asset-worker.js") response.writeHead(200, { "content-type": "text/javascript" }).end(script)
    else if (request.url === "/binary-v1.wasm") {
      response.writeHead(200, { "content-type": "application/wasm" }).end(bytes)
    } else {response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><script>
      const worker = new Worker('/asset-worker.js', {type:'module'});
      window.assetReady = new Promise(resolve => worker.addEventListener('message', event => {if(event.data.ready)resolve()}, {once:true}));
      window.readAsset = url => new Promise(resolve => {worker.addEventListener('message', event => resolve(event.data), {once:true});worker.postMessage(url)});
    </script>`)}
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

for (const browser of [chromium, webkit]) {
  test(`${browser.name()}: a worker reads pre-cached WASM without its network`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-assets-"))
    const context = await browser.launchPersistentContext(directory)
    try {
      const page = await context.newPage()
      await page.goto(origin)
      await page.evaluate(async () => {
        await (window as any).assetReady
        const cache = await caches.open("sdk-precache-regression")
        await cache.put("/binary-v1.wasm", await fetch("/binary-v1.wasm"))
      })
      await context.setOffline(true)
      const result = await page.evaluate(() =>
        (window as any).readAsset(new URL("/binary-v1.wasm", location.href).href)
      )
      expect(result).toEqual({ bytes: [...bytes] })
    } finally {
      await context.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
