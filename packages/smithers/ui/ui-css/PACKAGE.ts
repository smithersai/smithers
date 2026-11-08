/** Source-only, framework-free component styles; checks and Bun suite mirror ui-styleguide. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui/ui-css"
const sources = Smithers.glob("//packages/smithers/ui/ui-css/src/**/*.ts")
const styleguide = Smithers.Target.subtree("//packages/smithers/ui/ui-styleguide/...", "sourceFiles")

const sourceFiles = Smithers.Filegroup({ srcs: [sources], cwd })
const check = Smithers.Typecheck({
  srcs: [sources],
  deps: [sourceFiles],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [sources, Smithers.glob("//packages/smithers/ui/ui-css/tests/**/*.ts"), Smithers.file("bunfig.toml"), Smithers.file("package.json")],
  deps: [styleguide],
  cwd
})
const docsFiles = Smithers.Filegroup({
  srcs: [Smithers.file("README.md"), Smithers.file("package.json")],
  cwd
})

export const Package = Smithers.Package({ targets: { sourceFiles, check, unitTests, docsFiles } })
