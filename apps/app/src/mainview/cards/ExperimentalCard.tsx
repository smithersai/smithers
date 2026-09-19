/*
 * The one card family every experimental mock renders through.
 *
 * The card carries a pane id rather than a payload shape, so the union does
 * not grow a kind per experiment and a card naming a pane this build no
 * longer has (promoted, renamed) still parses and says so in one line rather
 * than crashing the transcript.
 *
 * The drawing arrives in its own chunk: `React.lazy` over
 * `Registry.loadPane`, memoized per pane id so a card that re-renders does
 * not build a second lazy component and remount the pane. A failure is the
 * one thing not memoized. The identity the header shows comes from the
 * manifest, which is already loaded, so the packages line paints before the
 * chunk lands.
 */
import { lazy, Suspense } from "react"
import type { ComponentType } from "react"
import { manifestRow } from "../experimental/Manifest"
import { loadPane } from "../experimental/Registry"
import type { ExperimentalPaneContext } from "../experimental/Pane"
import { flowArgs } from "../flows/FlowArgs"
import type { CardFamily } from "./CardFamily"

type PaneProps = ExperimentalPaneContext

/*
 * One lazy component per pane, built once. `lazy` identity is what React uses
 * to decide whether the subtree is the same subtree, so building it during
 * render would throw the pane's own selection away on every parent update.
 */
const lazyPanes = new Map<string, ComponentType<PaneProps>>()

const lazyPane = (id: string): ComponentType<PaneProps> => {
  const existing = lazyPanes.get(id)
  if (existing !== undefined) return existing
  const component = lazy(async () => {
    try {
      const pane = await loadPane(id)
      return {
        default: (props: PaneProps) =>
          pane === undefined ? <p className="experimental-missing">No pane named {id}.</p> : pane.render(props)
      }
    } catch (error) {
      /*
       * A rejected `lazy` keeps throwing its first error for as long as it
       * lives (React stores the rejection on the payload and never calls the
       * loader again), so the entry leaves the map on the way out: the error
       * still reaches the card's boundary, and a later mount fetches the
       * chunk again rather than inheriting one blip forever.
       */
      lazyPanes.delete(id)
      throw error
    }
  }) as unknown as ComponentType<PaneProps>
  lazyPanes.set(id, component)
  return component
}

/** The experimental slice of the renderer map. */
export const experimentalCardFamily: CardFamily<"experimental"> = {
  experimental: {
    render: (card, actions) => {
      if (actions.experimental !== true) return <p className="experimental-missing">Experimental panes are disabled.</p>
      const row = manifestRow(card.payload.pane)
      if (row === undefined) return <p className="experimental-missing">No pane named {card.payload.pane}.</p>
      const Pane = lazyPane(row.id)
      return (
        <div className="experimental-pane" data-pane={row.id}>
          <p className="experimental-packages">{row.packages.join(" · ")}</p>
          <Suspense fallback={<p className="xp-empty">Loading.</p>}>
            <Pane
              cardId={card.id}
              props={card.payload.props ?? {}}
              set={(key, value) => actions.onRunCommand("experimental.set", flowArgs("experimental.set", { cardId: card.id, key, value }))}
              onRunCommand={actions.onRunCommand}
            />
          </Suspense>
        </div>
      )
    },
    pill: () => "mock"
  }
}
