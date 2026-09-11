import type { AppController } from "./state/AppController"

/**
 * The one boot a browser page runs, started by the first render.
 *
 * `use(boot)` suspends on the promise it is handed, so every render and every
 * remount has to receive the same promise: a fresh promise per render
 * re-suspends forever.
 */
export const createControllerBoot = (
  load: () => Promise<AppController>
): () => Promise<AppController> => {
  let boot: Promise<AppController> | undefined
  return (): Promise<AppController> => (boot ??= load())
}
