import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)

test("the built serializer subpath shares canonical bytes for CJS and ESM", async () => {
  const cjs = require("../dist/cjs/Serializer.js")
  const esm = await import("../dist/esm/Serializer.js")
  assert.equal(cjs.canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(esm.canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
})

test("the built root exports canonicalize to CJS and ESM consumers", async () => {
  const cjs = require("../dist/cjs/index.js")
  const esm = await import("../dist/esm/index.js")
  assert.equal(cjs.canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(esm.canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}')
  for (const api of [cjs, esm]) {
    assert.equal(api.BoundedJson.encodedStringBytes("\n"), 4)
    assert.equal(api.BoundedJson.admit({ ok: true }, { maxDepth: 2, maxNodes: 4, maxMembers: 2 }).ok, true)
  }
})
