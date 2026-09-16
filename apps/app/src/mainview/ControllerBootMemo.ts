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

/** Independent reads start together; a failed bootstrap cannot leak an opened store. */
export const loadControllerBootInputs = async <Bootstrap, Store extends { dispose?: () => void | Promise<void> }>(
  loadBootstrap: () => Promise<Bootstrap>,
  createStore: () => Promise<Store>,
): Promise<{ bootstrap: Bootstrap; store: Store }> => {
  const [bootstrap, store] = await Promise.allSettled([loadBootstrap(), createStore()])
  if (bootstrap.status === "rejected") {
    if (store.status === "fulfilled") await store.value.dispose?.()
    throw bootstrap.reason
  }
  if (store.status === "rejected") throw store.reason
  return { bootstrap: bootstrap.value, store: store.value }
}

/** Only an empty anonymous practice entry may paint before cloud identity answers. */
export const canPaintAppBeforeIdentity = (entry: {
  requestedRepo?: string | null
  hasTranscript: boolean
  identityState?: string
  identityLogin?: string | null
  accountOwnerLogin?: string | null
}): boolean => entry.requestedRepo == null &&
  !entry.hasTranscript && entry.identityState !== "signed-in" && entry.identityLogin == null && entry.accountOwnerLogin == null
