/** Short source files can contain the suite's longest real recovery scenarios. */
import { statSync } from "node:fs"
import { BaseSequencer, type TestSpecification } from "vitest/node"

export default class CliSequencer extends BaseSequencer {
  override async sort(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    // A cold Vitest cache can lack both timings and file stats. Its default
    // comparator then preserves discovery order, leaving large process suites
    // late in an alphabetical queue. Read actual sizes for a stable cold plan.
    const sizes = new Map(files.map((file) => [file.moduleId, statSync(file.moduleId).size]))
    // Real process counts and lease waits dominate these small source files.
    // Dispatch them early instead of inferring their cost from source bytes.
    const priority = (file: TestSpecification) => {
      const path = file.moduleId.replaceAll("\\", "/")
      if (path.endsWith("/NativeControlExternalPeerRecovery.test.ts")) return 0
      if (/\/Bin(?:Launch|Migration|Runtime|Scaffold|Routing|Startup)?\.test\.ts$/.test(path)) return 1
      return 2
    }
    return [...files].sort((a, b) =>
      priority(a) - priority(b) || sizes.get(b.moduleId)! - sizes.get(a.moduleId)! ||
      (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0)
    )
  }
}
