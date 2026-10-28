import { useLiveQuery } from "@tanstack/react-db"
import type { ReactNode } from "react"
import { showsGate } from "../view"
import { useFirstRun } from "./FirstRunContext"

// The composer's place on `/app` during a first run (decision 0121): the gate and the composer behind it when it isn't
// a first run, and at Ask, where the composer's own Chat ⌘K is the step's button. Before Ask the list carries the
// step's button, so nothing shows here. The children keep their place in the tree, so opening the composer never
// mounts it again.
export function FirstRunGate({ children }: { readonly children: ReactNode }) {
  const { queries } = useFirstRun()
  const { data: firstRun } = useLiveQuery(queries.state)
  return showsGate(firstRun) ? children : null
}
