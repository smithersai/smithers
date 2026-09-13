// Both modes ship in the same Electrobun bundle and use its bundled Bun.
// The daemon never initializes the native SDK or creates a window.
if (Bun.env.SMITHERS_LOCAL_DAEMON_ACTION === "stop") {
  const { stopNativeDaemon } = await import("./LocalDaemonStop")
  await stopNativeDaemon()
} else if (Bun.env.SMITHERS_LOCAL_DAEMON === "1") {
  const { runLocalDaemon } = await import("./LocalDaemon")
  await runLocalDaemon()
} else {
  await import("./NativeApp")
}
export {}
