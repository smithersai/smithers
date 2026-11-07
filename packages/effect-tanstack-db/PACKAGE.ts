import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
/** Standard package targets for the TanStack DB Effect wrapper. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/effect-tanstack-db"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("{src,examples}/**/*.ts"),
  cwd
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test }
})
