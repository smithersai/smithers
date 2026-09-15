import { spawnSync } from "node:child_process"

export const dockerProbeBudget = 10_000
export const docker = (args: Array<string>) => {
  // spawnSync waits for the child to exit even after its timeout. SIGKILL
  // keeps a child that ignores SIGTERM from blocking prerequisite or cleanup.
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: dockerProbeBudget, killSignal: "SIGKILL" })
  // A stalled daemon is a failed prerequisite, not evidence that Docker is
  // absent. Report it instead of silently skipping the guest assertions or
  // blocking forever during synchronous cleanup.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`Docker ${args[0]} did not respond within ${dockerProbeBudget}ms`, { cause: result.error })
  }
  return result
}
