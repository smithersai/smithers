import { spawn } from "node:child_process"
import type { RepositoryAuthority } from "./RepositoryAuthority"
import {
  DAEMON_PROTOCOL, daemonRequest, isDaemonUnavailable, prepareDaemonDirectory, readDaemonDescriptor,
  sameConfiguration, type DaemonConfiguration, type DaemonDescriptor
} from "./LocalDaemonProtocol"

export interface LocalDaemonAttachment {
  readonly origin: string
  readonly instance: string
  readonly authorizeRepository: RepositoryAuthority["authorize"]
  /** Native window lifetime ends here. No process or server is stopped. */
  readonly detach: () => Promise<void>
  /** Explicit owner shutdown, used by maintenance and isolated test cleanup. */
  readonly shutdown: () => Promise<void>
}
const probe = async (stateDir: string): Promise<DaemonDescriptor | undefined> => {
  const descriptor = await readDaemonDescriptor(stateDir)
  if (descriptor === undefined) return undefined
  let response: Response
  try { response = await daemonRequest(descriptor, "/health") } catch (error) {
    // No stored PID is signalled. An unresponsive live owner is never replaced.
    if (await isDaemonUnavailable(error, descriptor)) return undefined
    throw new Error("The Smithers session owner is not responding; its sessions were left running.", { cause: error })
  }
  if (!response.ok) throw new Error("The Smithers session owner refused authentication.")
  const health = await response.json() as { instance?: unknown; protocol?: unknown }
  if (health.instance !== descriptor.instance || health.protocol !== descriptor.protocol) {
    throw new Error("The Smithers session owner identity changed; refusing to attach.")
  }
  return descriptor
}
export const attachLocalDaemon = async (
  configuration: DaemonConfiguration,
  options: { readonly entrypoint: string; readonly executable?: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv }
): Promise<LocalDaemonAttachment> => {
  await prepareDaemonDirectory(configuration.stateDir)
  let descriptor = await probe(configuration.stateDir)
  if (descriptor === undefined) {
    const child = spawn(options.executable ?? process.execPath, [options.entrypoint], {
      detached: true,
      stdio: "ignore",
      env: { ...(options.env ?? process.env), SMITHERS_LOCAL_DAEMON: "1", SMITHERS_DAEMON_CONFIGURATION: JSON.stringify(configuration) }
    })
    let failed: Error | undefined
    child.on("error", (error) => { failed = error })
    child.unref()
    const deadline = Date.now() + (options.timeoutMs ?? 15_000)
    while (descriptor === undefined && Date.now() < deadline) {
      if (failed !== undefined) throw failed
      await Bun.sleep(50)
      descriptor = await probe(configuration.stateDir)
    }
    if (descriptor === undefined) {
      throw new Error("The Smithers session owner did not start; inspect local-daemon/daemon.log. The saved origin and sessions were preserved.")
    }
  }
  if (descriptor.protocol !== DAEMON_PROTOCOL || !sameConfiguration(descriptor.configuration, configuration)) {
    throw new Error("A different Smithers build or configuration owns the running sessions. Close those sessions and explicitly shut down that owner before switching builds; they have been left running.")
  }
  const owner = descriptor
  let detached = false
  return {
    origin: owner.origin,
    instance: owner.instance,
    authorizeRepository: async (path, access) => {
      if (detached) throw new Error("The native application has detached.")
      const response = await daemonRequest(owner, "/authorize-repository", { path, access })
      if (!response.ok) throw new Error("The session owner refused the repository selection.")
      return response.json()
    },
    detach: async () => { detached = true },
    shutdown: async () => {
      const response = await daemonRequest(owner, "/shutdown", {})
      if (!response.ok) throw new Error("The session owner could not stop all of its processes.")
      detached = true
    }
  }
}
