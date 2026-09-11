import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  // The helper's Python source and its generator: the parity test reads both,
  // so an edit to either alone has to rerun it.
  testData: ["src/internal/AtomicFileSystemHelper.py", "scripts/generate-atomic-helper.mjs"],
  cwd: "packages/smithers/flows/platform-node"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
