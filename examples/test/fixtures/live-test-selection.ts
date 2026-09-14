/**
 * Collects the real provider tests without executing model calls.
 *
 * @since 0.1.0
 */
import { createVitest } from "vitest/node"
import assert from "node:assert/strict"

const implementations = new Set([
  new URL("../../src/12-agent-live-smoke.ts", import.meta.url).pathname,
  new URL("../../src/13-agent-live-smoke-local.ts", import.meta.url).pathname
])
const implementationImports: string[] = []

// Bypass the suite's credential masking to prove each test owns its gate.
const runner = await createVitest("test", { config: false, watch: false, maxWorkers: 1, reporters: [] }, {
  plugins: [{
    name: "assert-live-selection-imports",
    load(id) {
      if (implementations.has(id.split("?")[0]!)) {
        implementationImports.push(id)
        // Fail before transforming the native agent stack. Listing tests must
        // remain bounded even when a live test accidentally imports it eagerly.
        throw new Error(`Live test selection loaded an implementation: ${id}`)
      }
    }
  }]
})
try {
  // Static collection cannot evaluate environment-dependent skipIf conditions
  // or Effect test options. Import the declarations without running their bodies.
  const { testModules, unhandledErrors } = await runner.collect([
    "test/12-agent-live-smoke.test.ts",
    "test/13-agent-live-smoke-local.test.ts"
  ], { staticParse: false })
  assert.deepEqual(implementationImports, [], "collection must defer live implementations until test execution")
  if (unhandledErrors.length > 0) throw new AggregateError(unhandledErrors)
  const tests = testModules.flatMap((module) =>
    [...module.children.allTests()].map((test) => ({
      file: module.relativeModuleId,
      name: test.fullName,
      mode: test.options.mode,
      timeout: test.options.timeout
    }))
  )
  process.stdout.write(JSON.stringify(tests))
} finally {
  await runner.close()
}
