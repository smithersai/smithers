import { daemonRequest, isDaemonUnavailable, prepareDaemonDirectory, readDaemonDescriptor } from "./LocalDaemonProtocol"
import { nativeStateDirectory } from "./NativeState"

/** An explicit operation, usable even when this build cannot attach to an older owner. */
export const shutdownLocalDaemon = async (stateDir: string): Promise<"stopped" | "absent"> => {
  await prepareDaemonDirectory(stateDir)
  const owner = await readDaemonDescriptor(stateDir)
  if (owner === undefined) return "absent"
  try {
    const response = await daemonRequest(owner, "/shutdown", {})
    if (!response.ok) throw new Error("The session owner did not stop all processes; its state has been retained.")
    await response.arrayBuffer()
    return "stopped"
  } catch (error) {
    if (await isDaemonUnavailable(error, owner)) return "absent"
    throw error
  }
}

export const stopNativeDaemon = async (): Promise<void> => {
  const result = await shutdownLocalDaemon(nativeStateDirectory())
  console.log(result === "stopped" ? "Smithers session owner stopped." : "No Smithers session owner is running.")
}

if (import.meta.main) await stopNativeDaemon()
