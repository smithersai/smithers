import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "Smithers",
    identifier: "sh.smithers.app",
    version: "0.0.1"
  },
  build: {
    /*
     * The lowest-risk bridge from the 1.18 app: the main process stays on
     * Bun, so src/bun keeps its Bun.serve local origin.
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
      ".native/bin": "bin",
      ".native/postgres": "postgres",
      ".native/licenses": "licenses"
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
