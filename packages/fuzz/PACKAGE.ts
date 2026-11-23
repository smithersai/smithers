// Smithers discovers targets only in PACKAGE.ts.
import { BuildAndCheckTypeScriptPackage, WorkspaceSources } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/fuzz"
const workspaceSources = WorkspaceSources({ cwd })

const { bench, check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  cwd,
  deps: [],
  reads: Object.values(workspaceSources)
})
export const Package = Smithers.Package({
  targets: { bench, check, circular, docs, docsFiles, fmt, lib, lint, test, ...workspaceSources }
})
