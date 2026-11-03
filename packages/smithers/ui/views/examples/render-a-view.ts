/**
 * What a host does with a renderer's module: check it against the components
 * the realm's bundle carries, render it, and then play one interaction.
 *
 * The realm comes from the host's layer: `PresentationRealm.layer({ bundle })`
 * over the QuickJS build it names (`QuickJSVariant.layerVariant` from
 * `@smthrs/harness`). The test beside this example provides both.
 */
import { type Interactions, PresentationRealm, ViewCode } from "@smthrs/views"
import * as Effect from "effect/Effect"

/** A two-button counter: one state interaction, no model call per click. */
export const counter = `import { Button, Card } from "@smthrs/ui"
import type { ViewProps } from "smithers:view"

export const interactions = { add: { kind: "state" } }
export const reduce = (state: number, event: { name: string; arg?: string }) => state + Number(event.arg ?? 1)

export default function View({ props, state }: ViewProps<number>) {
  return (
    <Card>
      <p>{props.label}: {state}</p>
      <Button data-event="add:1">+1</Button>
      <Button data-event="add:10">+10</Button>
    </Card>
  )
}
`

/** Checks and renders `source`, then applies `event` the way a click would. */
export const program = (source: string, event: Interactions.Event) =>
  Effect.gen(function*() {
    const realm = yield* PresentationRealm.PresentationRealm
    const module = yield* ViewCode.check(source, { components: realm.components })
    const first = yield* realm.render({ module, props: { label: "Count" }, state: 0 })
    const next = yield* realm.interact({ module, props: { label: "Count" }, state: 0, event })
    return { interactions: module.interactions, first, next }
  })
