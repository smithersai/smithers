import type { Host } from "@smthrs/plugin"
import { Badge, type BadgeProps } from "@smthrs/ui"
import { type ReactNode, useSyncExternalStore } from "react"
import type { Tone } from "../model"
import type { FleetTab, Watched } from "../tab"

// The small parts the fleet draws with.

/** A watched value's current one, re-rendered when it changes. */
export const useWatched = <A,>(watched: Watched<A>): A => useSyncExternalStore(watched.subscribe, watched.current)

const VARIANT: Readonly<Record<Tone, NonNullable<BadgeProps["variant"]>>> = {
  ok: "success",
  warn: "warning",
  bad: "destructive",
  run: "default",
  muted: "muted",
}

/** A short state in its tone. */
export function Pill({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return <Badge variant={VARIANT[tone]} data-tone={tone}>{children}</Badge>
}

/** What every view gets: the tab and the repository it shows on. */
export interface ViewProps {
  readonly tab: FleetTab
  readonly repository?: Host.Repository | undefined
}
