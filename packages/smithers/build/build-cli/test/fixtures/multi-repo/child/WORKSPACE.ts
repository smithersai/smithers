import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("multi-repo-child", {
  repository: "git+https://example.invalid/multi-repo-child.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
