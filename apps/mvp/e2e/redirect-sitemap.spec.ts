import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("docsSite")
test("the sitemap omits the noindex bug redirect", async ({ request }) => {
  const sitemap = await request.get("/sitemap-0.xml")
  expect(sitemap.status()).toBe(200)
  const body = await sitemap.text()
  expect(body).toContain("<urlset")
  expect(body).not.toMatch(/<loc>[^<]*\/bug\/?<\/loc>/)
  const redirect = await request.get("/bug/")
  expect(await redirect.text()).toContain("noindex")
})
