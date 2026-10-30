/** Real Node children preserve scratch, cache and coverage ownership. */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process"
import { temporaryEnvironment } from "../temporaryEnvironment.ts"

export const childEnvironment = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...base,
  // A deliberately narrow environment stays narrow. Only the owning run's
  // temporary and cache fields cross this boundary from the measured worker.
  ...temporaryEnvironment({ ...process.env, ...base })
})

export const spawnNodeSync = (args: ReadonlyArray<string>, options: SpawnSyncOptionsWithStringEncoding) =>
  spawnSync(process.execPath, [...args], { ...options, env: childEnvironment(options.env) })
