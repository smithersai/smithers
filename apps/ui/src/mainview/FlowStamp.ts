/*
 * `data-flow` on affordances the host does not render itself.
 *
 * The launch law is that every visible affordance names the flow behind it, and
 * `data-flow` is how it says so — the slash listing, the launch checklist and
 * the agent's own manifest all read it. Where the component that renders an
 * affordance takes a pass-through prop the host uses it (`ChatComposer`'s
 * `submitProps`, `FileTree`'s `nodeProps`); this is for the ones that do not
 * yet — the Wiki graph's node buttons and the Wiki rail's outline and backlink
 * rows. See LIBRARY-CHANGE-REQUESTS.md §3.
 */

/** One selector and the registered flow the elements it matches invoke. */
export type FlowBindingHint = readonly [selector: string, flow: string]

/**
 * Stamps `data-flow` on every match under `root`.
 *
 * Written as a React ref callback: an inline callback re-runs on every commit,
 * so an affordance that appears mid-turn (Stop) or mid-list (a new note) is
 * stamped as soon as it exists. Stamping is idempotent and never overrides a
 * `data-flow` the element already carries.
 */
export const stampFlows = (hints: ReadonlyArray<FlowBindingHint>) => (root: HTMLElement | null): void => {
  if (root === null) return
  for (const [selector, flow] of hints) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (element.getAttribute("data-flow") === null) element.setAttribute("data-flow", flow)
    }
  }
}
