import { Cause, Effect, Exit } from "effect"
import * as Runner from "../../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../../src/PackageDiscovery.ts"
import * as PackageExec from "../../src/PackageExec.ts"
import { PackageIndex } from "../../src/PackageIndex.ts"
import * as PackageLoader from "../../src/PackageLoader.ts"

/** Runs the real planner and executor with invocation-local Effect fault services. */
export const executeWithServices = async (
  root: string,
  patterns: ReadonlyArray<string>,
  services: Runner.ExecutionServices,
  settings: { readonly signal?: AbortSignal; readonly write?: boolean; readonly onLog?: (line: string) => void } = {}
) => {
  let logs = ""
  const options = {
    index: PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root),
    cacheDirectory: ".flows",
    verb: "auto",
    patterns,
    signal: settings.signal,
    write: settings.write,
    log: (line: string) => {
      logs += line + "\n"
      settings.onLog?.(line)
    }
  } as const
  const plan = await PackageExec.plan(options)
  const exit = await Effect.runPromiseExit(
    Runner.executeEffect(plan, options).pipe(Effect.provideService(Runner.ExecutionServices, services)),
    { signal: settings.signal }
  )
  if (Exit.isFailure(exit)) logs += String(Cause.squash(exit.cause))
  return { exitCode: Exit.isSuccess(exit) && exit.value.ok ? 0 : 1, output: "", logs }
}
