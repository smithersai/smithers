// Stays .ts: Electrobun discovers its configuration only as electrobun.config.ts.
const testBuild = process.env.VIBELANG_DESKTOP_TEST === "1"
const buildEnvironment = process.argv.find((arg) => arg.startsWith("--env="))?.split("=")[1]
if (testBuild && buildEnvironment === "stable") {
  // Electrobun catches import errors and falls back to defaults; stop before packaging.
  console.error("VIBELANG_DESKTOP_TEST must be unset for stable builds")
  process.exit(1)
}

export default {
  app: { name: "VibeLang", identifier: "sh.smithers.vibelang", version: "0.0.0" },
  build: {
    bunVersion: "1.4.2",
    bun: { entrypoint: "dist-host/index.js", external: ["electrobun"] },
    copy: { "dist-view": "views/mainview", "dist-host/native": "native" },
    linux: { bundleCEF: true, defaultRenderer: "cef", chromiumFlags: testBuild ? { "remote-debugging-port": "14509", "disable-gpu": true, "disable-gpu-compositing": true } : {} },
    mac: { bundleCEF: true, defaultRenderer: "cef" },
  },
}
