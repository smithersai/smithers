import { defineConfig } from "vitest/config"
import base from "./vitest.config.ts"

/**
 * The suites that run recorded steps end to end, for the `testObserve` target: the same configuration as the
 * package suite, with only these files and no coverage (the package thresholds are held by `test`, over every file).
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/ObservedReadsExecution.test.ts", "test/MachineExecution.test.ts", "test/ObserveSupervisor.test.ts"],
    coverage: { ...base.test?.coverage, enabled: false }
  }
})
