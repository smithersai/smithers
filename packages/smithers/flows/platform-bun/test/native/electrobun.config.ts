// Stays .ts: Electrobun discovers its configuration only as electrobun.config.ts.
export default {
  app: { name: "SDKNative", identifier: "sh.smithers.sdk-native-test", version: "0.0.0" },
  build: {
    bunVersion: "1.4.2",
    bun: { entrypoint: "dist-host/index.js", external: ["electrobun"] },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "disable-gpu": true, "disable-gpu-compositing": true }
    },
    mac: { bundleCEF: true, defaultRenderer: "cef" }
  },
  runtime: { exitOnLastWindowClosed: false }
}
