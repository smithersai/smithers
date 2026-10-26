import { createServer } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { certificate } from "../dev/https.ts"

// A page on this machine that lets the app frame it, served over https with the dev server's certificate (made by its
// first start, dev/https.ts). 127.0.0.1 is another site than the app's localhost, so the app frames it, and a local
// dev server reads this machine's pages (`WEB_PAGES_LOCAL_HTTP`, docs/features/web-pages.md#the-guard-ssrf). An outside
// site is not a fixture: one that frames today can answer a headless browser with a page that refuses frames.

const DEV_CERTIFICATE = join(import.meta.dirname, "..", "node_modules", ".dev-https")

/** Serves `title` at `/` until `close`; its `url` is the page's. */
export const serveFramedPage = async (title: string) => {
  const { cert, key } = await certificate(DEV_CERTIFICATE)
  const server = createServer({ cert, key }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>${title}</title><body style="font:16px system-ui;padding:24px"><h1>${title}</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
