import assert from "node:assert/strict"
import { test } from "node:test"
import * as Effect from "effect/Effect"
import { docsSiteProps, makeDocsSiteStack } from "./alchemy-site.mjs"
import { sites } from "./manifest.mjs"

test("every manifest site declares a stack whose identity is a function of its slug", (t) => {
  // Deploy shells carried <SLUG>_WORKER_NAME and <SLUG>_SITE_DOMAIN overrides;
  // neither may rename a live Worker or move its hostname.
  const names = ["CLOUDFLARE_SMITHERS_ZONE_ID", ...sites.flatMap(({ slug }) => {
    const prefix = slug.toUpperCase().replaceAll("-", "_")
    return [`${prefix}_WORKER_NAME`, `${prefix}_SITE_DOMAIN`]
  })]
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  for (const name of names) process.env[name] = "operator-override"
  for (const { slug, domain } of sites) {
    assert.ok(Effect.isEffect(makeDocsSiteStack({ slug })), slug)
    const props = docsSiteProps(slug)
    assert.equal(props.name, `smithers-docs-${slug}-smithers-docs-${slug}-williamcory`)
    assert.deepEqual(props.domain, { name: domain, zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" })
  }
})
