// One part of //packages/ci:test (vitest.config.ts says why): every case the other three parts do not run, holding
// every source they do not hold.
import { configDefaults } from "vitest/config"
import { held, partWorkers, suite } from "./vitest.config.ts"

export default suite({
  include: [...configDefaults.include, "test/**/*.test.vibe"],
  exclude: Object.keys(held).map((part) => `test/${part}/**`),
  coverage: ["src/**"],
  coverageExclude: Object.values(held).flat(),
  workers: partWorkers.rest,
  part: { name: "testRest", cases: "test/, outside test/cli, test/replay and test/native" }
})
