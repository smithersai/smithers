import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const lockfile = S.file("//yarn.lock")

export const Workspace = S.Workspace("repo-plugin-fixture", {
  repository: "git+https://example.com/repo-plugin-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ manifest: packageJson }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  // The child workspace is declared, so the root graph prunes it instead of
  // refusing the nested WORKSPACE.ts; the app still queries each on its own.
  repos: { tools: S.LocalRepository("tools") },
})
