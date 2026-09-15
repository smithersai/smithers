import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const page = path => readFileSync(new URL(`../dist/${path}`, import.meta.url), "utf8")
const meta = (html, name) => [...html.matchAll(/<meta\b[^>]*>/g)].find(([tag]) => tag.includes(`name="${name}"`) || tag.includes(`property="${name}"`))?.[0]

for (const path of ["smithersai/smithers/index.html", "docs/index.html"]) {
  test(`${path} shares a description and social preview with a resolvable image`, () => {
    const html = page(path)
    for (const name of ["description", "og:title", "og:description", "og:image", "twitter:card", "twitter:image"]) {
      assert.match(meta(html, name) ?? "", /content="[^"\s][^"]*"/, `${name} is populated`)
    }
    assert.match(meta(html, "og:image"), /content="https:\/\/smithers.sh\/media\/og.png"/)
    assert.equal(readFileSync(new URL("../dist/media/og.png", import.meta.url)).subarray(1, 4).toString(), "PNG")
  })
}

test("the not-found page exposes its existing recovery link as a button", () => {
  const recovery = page("404.html").match(/<a\b[^>]*>Go to the home page<\/a>/)?.[0]
  assert.match(recovery ?? "", /href="\/"/)
  assert.match(recovery, /class="[^"]*\bbtn\b/)
})
