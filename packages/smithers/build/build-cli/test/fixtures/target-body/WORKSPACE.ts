import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const Workspace = S.Workspace("target-body-fixture", {
  repository: "git+https://example.invalid/target-body-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ manifest: packageJson }),
  packageManager: S.PackageManager.Pnpm({
    manifest: packageJson,
    lockfile: S.file("//pnpm-lock.yaml")
  }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["node"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
