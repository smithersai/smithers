// Smithers discovers targets only in PACKAGE.ts.
import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"
const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  cwd: "packages/fuzz",
  deps: []
})
export const Package = Smithers.Package({ targets: { check, circular, docs, docsFiles, fmt, lib, lint, test } })
