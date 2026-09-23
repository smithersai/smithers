import { Smithers as S } from "@smthrs/targets"
import { agents } from "./agents.ts"
import { sandboxes } from "./sandbox.ts"

const packageJson = S.file("//package.json")
const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("__APP_NAME__", {
  repository: "git+https://example.invalid/__APP_NAME__.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["wrangler", "git"] }),
  sandboxes,
  agents
})
