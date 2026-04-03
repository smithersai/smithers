import { startDaemon, stopDaemon } from "@/bootstrap/daemon-lifecycle"

let stopping = false

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (stopping) {
    return
  }

  stopping = true
  try {
    await stopDaemon({ signal })
    process.exit(0)
  } catch {
    process.exit(1)
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})

try {
  await startDaemon()
} catch {
  process.exit(1)
}
