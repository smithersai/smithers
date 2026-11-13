import assert from "node:assert/strict"
import * as root from "@smthrs/observability"

assert.deepEqual(Object.keys(root).sort(), process.argv.slice(2).sort())

for (const name of Object.keys(root)) {
  const subpath = await import(`@smthrs/observability/${name}`)
  for (const [key, value] of Object.entries(subpath)) {
    assert.strictEqual(root[name][key], value, `${name}.${key} has one ESM identity`)
  }
}

for (const name of ["BrowserOtel", "NodeOtel"]) {
  const subpath = await import(`@smthrs/observability/${name}`)
  assert.equal(typeof subpath.layerOtel, "function")
}
