import assert from "node:assert/strict"
import * as root from "../../dist/esm/index.js"

const rootModules = ["FetchFailures", "JournalLogger", "LogFailures", "Logger", "Metric", "Otel", "Otlp", "Resource"]
for (const name of rootModules) {
  const subpath = await import(`../../dist/esm/${name}.js`)
  for (const [key, value] of Object.entries(subpath)) {
    assert.strictEqual(root[name][key], value, `${name}.${key} has one ESM identity`)
  }
}

for (const name of ["BrowserOtel", "NodeOtel"]) {
  const subpath = await import(`../../dist/esm/${name}.js`)
  assert.equal(typeof subpath.layerOtel, "function")
}
