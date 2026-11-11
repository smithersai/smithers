await import(import.meta.resolve("vibelang/register"))
const Bridge = await import("../../src/cli/ControlBridge.ts")
const controller = new AbortController()
controller.abort(new Error("cancelled startup"))
try {
  await Bridge.host({ host: "127.0.0.1", port: 0, listen: false, credential: undefined }, {
    root: process.cwd(),
    quiet: true
  }, { environment: {}, signal: controller.signal })
} catch {
  // The failure is expected; stderr must still respect the invocation policy.
}
