import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "Burns",
    identifier: "ai.burns.desktop",
    version: "0.1.0",
    description: "Burns desktop shell",
  },
  build: {
    bun: {
      entrypoint: "./src/index.ts",
    },
    buildFolder: "../../dist/desktop/build",
    artifactFolder: "../../dist/desktop/artifacts",
    copy: {
      "../../dist/web": "views/mainview",
      "./assets/tray/favicon-black.png": "views/tray/favicon-black.png",
      "./assets/tray/favicon-white.png": "views/tray/favicon-white.png",
    },
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      icons: "../../assets/icons/macos.iconset",
    },
    win: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "../../assets/icons/app-icon.png",
    },
    linux: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "../../assets/icons/app-icon.png",
    },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  scripts: {
    preBuild: "./scripts/prebuild-web.ts",
    postBuild: "./scripts/copy-web-assets.ts",
  },
} satisfies ElectrobunConfig
