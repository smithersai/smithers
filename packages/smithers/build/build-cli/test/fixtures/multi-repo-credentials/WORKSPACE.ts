import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("multi-repo-credentials-parent", {
  repository: "git+https://example.invalid/multi-repo-credentials-parent.git",
  cache: S.Cache({
    directory: ".flows",
    remote: S.RemoteCache.make({
      endpoint: "https://build.example.invalid",
      read: S.Secret("MY_CACHE_TOKEN"),
      write: S.Secret("MY_CACHE_WRITE_TOKEN")
    })
  }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  repos: {
    child: S.LocalRepository("child")
  }
})
