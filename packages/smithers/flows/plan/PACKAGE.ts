import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets plus package-owned documentation generation.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/plan"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
