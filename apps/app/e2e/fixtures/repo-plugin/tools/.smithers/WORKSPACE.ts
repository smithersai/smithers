import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const lockfile = S.file("//yarn.lock")

export const Workspace = S.Workspace("repo-plugin-fixture-tools", {
  repository: "git+https://example.com/repo-plugin-fixture-tools.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ manifest: packageJson }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
