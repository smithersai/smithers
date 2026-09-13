import { expect, test } from "bun:test"
import { buildFaviconSvg } from "./render-favicon.ts"

test("committed SVGs match the builder output (drift guard)", async () => {
  const expected = buildFaviconSvg()
  const site = await Bun.file(new URL("../../site/public/favicon.svg", import.meta.url)).text()
  const app = await Bun.file(new URL("../src/mainview/public/favicon.svg", import.meta.url)).text()
  expect(site).toBe(expected)
  expect(app).toBe(expected)
})

test("uses the wordmark greens, never the old purple", () => {
  const svg = buildFaviconSvg()
  expect(svg).toContain("#3a756b")
  expect(svg).toContain("#9bd5c6")
  expect(svg).not.toContain("#994cc3")
})

test("all block runs live in exactly one fg path", () => {
  const svg = buildFaviconSvg()
  expect(svg.match(/<path class="fg"/g)).toHaveLength(1)
})
