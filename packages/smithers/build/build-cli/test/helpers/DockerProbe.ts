import * as NodeChildProcess from "node:child_process"

/** A stalled prerequisite is a setup failure, never a successful skipped suite. */
export const dockerAvailable = (): boolean => {
  const probe = NodeChildProcess.spawnSync("docker", ["info"], {
    stdio: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL"
  })
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error("Docker availability probe timed out after 5000ms", { cause: probe.error })
  }
  return probe.status === 0
}
