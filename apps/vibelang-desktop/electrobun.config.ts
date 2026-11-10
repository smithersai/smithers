// Stays .ts: Electrobun discovers its configuration only as electrobun.config.ts.
export default {
  app: { name: "VibeLang", identifier: "sh.smithers.vibelang", version: "0.0.0" },
  build: {
    bunVersion: "1.4.2",
    bun: { entrypoint: "dist-host/index.js", external: ["electrobun"] },
    copy: { "dist-view": "views/mainview", "dist-host/native": "native" },
    linux: { bundleCEF: true, defaultRenderer: "cef", chromiumFlags: process.env.VIBELANG_DESKTOP_TEST === "1" ? { "remote-debugging-port": "14509", "disable-gpu": true, "disable-gpu-compositing": true } : {} },
    mac: { bundleCEF: true, defaultRenderer: "cef" },
  },
}
