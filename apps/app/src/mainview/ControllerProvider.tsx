import { use } from "react"
import type { ReactNode } from "react"
import type { ControllerBootOptions } from "./ControllerBoot.client"
import { createControllerBoot } from "./ControllerBootMemo"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"

/*
 * The boot module is reached through a dynamic import, not a static one, so it
 * lands in a chunk of its own. Prefetch evaluates the module but never starts
 * boot or opens storage. Both hosts are browser-only — main.tsx renders
 * AppIsland into `#root`, apps/site renders it as an Astro `client:only`
 * island — so nothing here has to survive a server render; what the split buys
 * is the paint order. The persistent entrance paints while the boot chunk and the
 * native bridge it pulls in are still in flight, which e2e/playwright/
 * startup.spec.ts holds open by routing `ControllerBoot.client*.js`.
 */
let bootOptions: ControllerBootOptions = {}
const bootModule = import("./ControllerBoot.client")
void bootModule.catch(() => {})
const preparedControllers = new WeakMap<Promise<AppController>, AppController>()
const observedBoots = new WeakSet<Promise<AppController>>()

/** Set how the one boot runs; it must precede the first render (AppMount.tsx). */
export const configureControllerBoot = (options: ControllerBootOptions): void => {
  bootOptions = options
}

export const controllerBootPromise = createControllerBoot(() =>
  bootModule.then(({ runControllerBoot }) => runControllerBoot(bootOptions))
)

/** Prepare the same boot a later mount consumes; options are known before entry. */
export const prepareControllerBoot = (options: ControllerBootOptions): Promise<AppController> => {
  bootOptions = { ...bootOptions, ...options }
  const boot = controllerBootPromise()
  if (!observedBoots.has(boot)) {
    observedBoots.add(boot)
    void boot.then(controller => preparedControllers.set(boot, controller), () => {})
  }
  return boot
}

export function ControllerProvider({
  boot,
  children
}: {
  readonly boot: Promise<AppController>
  readonly children: ReactNode
}) {
  const controller = preparedControllers.get(boot) ?? use(boot)
  return <ControllerContext value={controller}>{children}</ControllerContext>
}
