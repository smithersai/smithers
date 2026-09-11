import { createContext, useContext } from "react"
import type { ReactNode } from "react"
import type { AppController } from "./state/AppController"

export const ControllerContext = createContext<AppController | null>(null)

/** A synchronous scope for component tests that construct their controller explicitly. */
export function ControllerTestProvider({
  controller,
  children
}: {
  readonly controller: AppController
  readonly children: ReactNode
}) {
  return <ControllerContext value={controller}>{children}</ControllerContext>
}

export const useController = (): AppController => {
  const controller = useContext(ControllerContext)
  if (controller === null) throw new Error("useController must be rendered inside ControllerProvider")
  return controller
}
