/** Short source files can contain the suite's longest real recovery scenarios. */
import { BaseSequencer, type TestSpecification } from "vitest/node"

export default class CliSequencer extends BaseSequencer {
  override async sort(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const ordered = await super.sort(files)
    // Real process counts and lease waits dominate these small source files.
    // Dispatch them early instead of inferring their cost from source bytes.
    const priority = (file: TestSpecification) => {
      const path = file.moduleId.replaceAll("\\", "/")
      if (path.endsWith("/NativeControlExternalPeerRecovery.test.ts")) return 0
      if (/\/Bin(?:Launch|Migration|Runtime|Scaffold|Routing|Startup)?\.test\.ts$/.test(path)) return 1
      return 2
    }
    return ordered.sort((a, b) => priority(a) - priority(b))
  }
}
