import { BuildAndCheckTypeScriptPackage, SdkRules, WorkspaceSources } from "@smthrs/repo-targets"
/** Standard package targets for the TanStack DB Effect wrapper. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/effect-tanstack-db"
const workspaceSources = WorkspaceSources({ cwd })

const { bench, check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  reads: [...Object.values(workspaceSources)],
  sources: Input.glob("{src,examples}/**/*.ts"),
  cwd
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { bench, check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...workspaceSources }
})
