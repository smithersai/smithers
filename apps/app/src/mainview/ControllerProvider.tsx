import { use } from "react"
import type { ReactNode } from "react"
import type { ControllerBootOptions } from "./ControllerBoot.client"
import { createControllerBoot } from "./ControllerBootMemo"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"

/*
 * The boot module is reached through a dynamic import, not a static one, so it
 * lands in a chunk of its own. Both hosts are browser-only — main.tsx renders
 * AppIsland into `#root`, apps/site renders it as an Astro `client:only`
 * island — so nothing here has to survive a server render; what the split buys
 * is the paint order. The persistent entrance paints while the boot chunk and the
 * native bridge it pulls in are still in flight, which e2e/playwright/
 * startup.spec.ts holds open by routing `ControllerBoot.client*.js`.
 */
let bootOptions: ControllerBootOptions = {}

/** Set how the one boot runs; it must precede the first render (AppMount.tsx). */
export const configureControllerBoot = (options: ControllerBootOptions): void => {
  bootOptions = options
}

export const controllerBootPromise = createControllerBoot(() =>
  import("./ControllerBoot.client").then(({ runControllerBoot }) => runControllerBoot(bootOptions))
)

export function ControllerProvider({
  boot,
  children
}: {
  readonly boot: Promise<AppController>
  readonly children: ReactNode
}) {
  const controller = use(boot)
  return <ControllerContext value={controller}>{children}</ControllerContext>
}
