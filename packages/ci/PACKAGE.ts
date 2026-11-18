import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/ci"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("src/**/*.ts"),
  cwd
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
