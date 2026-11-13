import { Context, Effect } from "effect"
import * as NodeChildProcess from "node:child_process"

type Probe = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdio: "ignore"; readonly timeout: number; readonly killSignal: "SIGKILL" }
) => Effect.Effect<{ readonly status: number | null; readonly error?: Error | undefined }>

/** The native process boundary; faults replace only this scoped service. */
export const DockerProbe = Context.Reference<{ readonly probe: Probe }>("build-cli/test/DockerProbe", {
  defaultValue: () => ({
    probe: (command, args, options) => Effect.sync(() => NodeChildProcess.spawnSync(command, args, options))
  })
})

/** A stalled prerequisite is a setup failure, never a successful skipped suite. */
export const dockerAvailableEffect = Effect.gen(function*() {
  const probe = yield* (yield* DockerProbe).probe("docker", ["info"], {
    stdio: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL"
  })
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return yield* Effect.die(new Error("Docker availability probe timed out after 5000ms", { cause: probe.error }))
  }
  return probe.status === 0
})

/** Synchronous suite-registration boundary using the real host by default. */
export const dockerAvailable = (): boolean => Effect.runSync(dockerAvailableEffect)
