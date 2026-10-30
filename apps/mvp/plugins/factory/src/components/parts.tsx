import type { Host } from "@smthrs/plugin"
import { Badge, type BadgeProps, Button, isPlainNavigationClick } from "@smthrs/ui"
import { type ComponentProps, type ReactNode, useSyncExternalStore } from "react"
import type { Tone, ViewId } from "../model"
import type { FactoryTab, Watched } from "../tab"

// The small parts every factory view draws with.

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
  readonly tab: FactoryTab
  readonly repository?: Host.Repository | undefined
}

/** A link to one of the factory's views that opens it in place on a plain click. */
export function ViewLink(
  { tab, repository, view, current, onClick, ...anchor }:
    & ViewProps
    & Omit<ComponentProps<"a">, "href">
    & { readonly view: ViewId; readonly current?: boolean },
) {
  return (
    <a
      {...anchor}
      href={tab.actions.href(view, repository!)}
      aria-current={current === true ? "page" : undefined}
      onClick={(event) => {
        onClick?.(event)
        if (!isPlainNavigationClick(event)) return
        event.preventDefault()
        tab.actions.open(view, repository!)
      }}
    />
  )
}

/** A section of a view: a small heading over its content. */
export function Section({ title, wide, children }: { readonly title: string; readonly wide?: boolean; readonly children: ReactNode }) {
  return (
    <section className="factory-section" data-wide={wide === true ? "" : undefined} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

/** Closes the opened document. */
export function Close({ tab }: { readonly tab: FactoryTab }) {
  return <Button variant="ghost" onClick={tab.actions.close}>Close</Button>
}
