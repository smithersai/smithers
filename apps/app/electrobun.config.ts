import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ElectrobunConfig } from "electrobun"

/*
 * The portable smithers-build runtime a packaged bundle carries. Only the
 * packaging paths (scripts/build-native.ts, e2e/packaged/run.ts) prepare it,
 * through scripts/prepare-packaged-build-cli.ts, and both remove it again
 * afterwards. `electrobun dev` runs the checkout's packages/smithers/build/build-cli instead
 * (src/bun/Targets.ts resolveBuildCli), so a missing runtime must not fail the
 * dev bundle with CopySourceMissing: the copy applies only when the runtime is
 * on disk. A bare `electrobun build` without that preparation ships no loader.
 */
const PACKAGED_BUILD_CLI = "packaged-runtime/build-cli"
const packagedBuildCliPrepared = existsSync(fileURLToPath(new URL(PACKAGED_BUILD_CLI, import.meta.url)))

export default {
  app: {
    name: "Smithers",
    identifier: "sh.smithers.app",
    version: "0.0.1"
  },
  build: {
    /*
     * The lowest-risk bridge from the 1.18 app: the main process stays on
     * Bun, so src/bun keeps its Bun.serve server and Bun.spawn sandboxing.
     */
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts"
    },
    // Vite builds to dist/; the bundle carries a copy and the main process
    // serves that same dist/ over the local origin.
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      ...(packagedBuildCliPrepared ? { [PACKAGED_BUILD_CLI]: "build-cli" } : {})
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      /*
       * §27.2: the bundle's Info.plist declared CFBundleIconFile "AppIcon"
       * and shipped no icon, so macOS drew the generic application icon in
       * the Dock, Finder and Cmd-Tab. `icon.iconset` carries the same mark
       * the browser tab uses, at every size iconutil asks for.
       */
      icons: "icon.iconset"
    },
    linux: {
      bundleCEF: false
    },
    win: {
      bundleCEF: false
    }
  }
} satisfies ElectrobunConfig
