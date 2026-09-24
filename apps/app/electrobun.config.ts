import type { ElectrobunConfig } from "electrobun"
import appPackage from "./package.json" with { type: "json" }

const cefSetting = process.env.SMITHERS_NATIVE_E2E_CEF?.trim()
if (cefSetting !== undefined && cefSetting !== "" && cefSetting !== "0" && cefSetting !== "1") {
  throw new Error("SMITHERS_NATIVE_E2E_CEF must be 0 or 1.")
}
const cefMatrix = cefSetting === "1"
const cdpSetting = process.env.SMITHERS_NATIVE_E2E_CDP_PORT?.trim()
if (!cefMatrix && cdpSetting) {
  throw new Error("SMITHERS_NATIVE_E2E_CDP_PORT is accepted only for the explicit CEF matrix artifact.")
}
if (cefMatrix && !cdpSetting) throw new Error("The CEF matrix artifact requires SMITHERS_NATIVE_E2E_CDP_PORT.")
if (cdpSetting && (!/^\d+$/.test(cdpSetting) || Number(cdpSetting) < 1024 || Number(cdpSetting) > 65535)) {
  throw new Error("SMITHERS_NATIVE_E2E_CDP_PORT must be an integer from 1024 through 65535.")
}

export default {
  app: {
    name: "Smithers",
    identifier: "sh.smithers.app",
    version: appPackage.version
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
      ".native/libexec": "libexec",
      ".native/share": "share",
      ".native/postgres": "postgres",
      ".native/licenses": "licenses"
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: cefMatrix,
      defaultRenderer: cefMatrix ? "cef" : "native",
      ...(cefMatrix
        ? {
          chromiumFlags: {
            "remote-debugging-address": "127.0.0.1",
            "remote-debugging-port": cdpSetting!
          }
        }
        : {}),
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
