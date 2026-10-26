const assert = require("node:assert/strict")
const root = require("../../dist/cjs/index.js")

const rootModules = ["FetchFailures", "JournalLogger", "LogFailures", "Logger", "Metric", "Otel", "Otlp", "Resource"]
for (const name of rootModules) {
  const subpath = require(`../../dist/cjs/${name}.js`)
  for (const [key, value] of Object.entries(subpath)) {
    assert.strictEqual(root[name][key], value, `${name}.${key} has one CJS identity`)
  }
}

for (const name of ["BrowserOtel", "NodeOtel"]) {
  const subpath = require(`../../dist/cjs/${name}.js`)
  assert.equal(typeof subpath.layerOtel, "function")
}
