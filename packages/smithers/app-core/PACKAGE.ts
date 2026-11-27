/** Standard package targets for @smthrs/app-core. */
import { BuildAndCheckTypeScriptPackage, WorkspaceSources } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/app-core"
const workspaceSources = WorkspaceSources({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  reads: [...Object.values(workspaceSources)],
  cwd
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    ...workspaceSources
  }
})
