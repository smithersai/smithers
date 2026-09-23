import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Shared model host library targets and its coverage-gated protocol suite. */
import { Smithers } from "@smthrs/targets"
import { Package as rpcPackage } from "../../../rpc/PACKAGE.ts"
import { Package as kernelPackage } from "../../flows/kernel/PACKAGE.ts"
import { Package as modelPackage } from "../model/PACKAGE.ts"

const cwd = "packages/smithers/agent/model-host"
const dependencies = [kernelPackage.lib, modelPackage.lib, rpcPackage.check]
const standard = BuildAndCheckTypeScriptPackage({ deps: dependencies, cwd })

export const Package = Smithers.Package({
  targets: {
    check: standard.check,
    docs: standard.docs,
    docsFiles: standard.docsFiles,
    fmt: standard.fmt,
    lib: standard.lib,
    lint: standard.lint,
    test: standard.test
  }
})
