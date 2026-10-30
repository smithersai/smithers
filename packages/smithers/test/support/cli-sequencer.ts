/** Short source files can contain the suite's longest real recovery scenarios. */
import { BaseSequencer, type TestSpecification } from "vitest/node"

export default class CliSequencer extends BaseSequencer {
  override async sort(files: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const ordered = await super.sort(files)
    // This file used to lead its own group. File-size ordering otherwise starts
    // its eight process scenarios in the last minutes of a cold coverage run.
    const priority = (file: TestSpecification) =>
      file.moduleId.replaceAll("\\", "/").endsWith("/NativeControlExternalPeerRecovery.test.ts") ? 0 : 1
    return ordered.sort((a, b) => priority(a) - priority(b))
  }
}
