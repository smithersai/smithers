const assert = require("node:assert/strict")
const root = require("@smthrs/observability")

assert.deepEqual(Object.keys(root).sort(), process.argv.slice(2).sort())

for (const name of Object.keys(root)) {
  const subpath = require(`@smthrs/observability/${name}`)
  for (const [key, value] of Object.entries(subpath)) {
    assert.strictEqual(root[name][key], value, `${name}.${key} has one CJS identity`)
  }
}

for (const name of ["BrowserOtel", "NodeOtel"]) {
  const subpath = require(`@smthrs/observability/${name}`)
  assert.equal(typeof subpath.layerOtel, "function")
}
