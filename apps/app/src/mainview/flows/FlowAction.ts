/** Bind once: click and speculative loading always receive the same arguments. */
export const flowAction = <N extends string>(run: (name: N, args?: string) => unknown, name: N, args?: string) => ({
  "data-flow": name,
  "data-flow-args": args,
  onClick: () => { run(name, args) },
})

/** One delegated listener covers native buttons, library buttons, menus and suggestion pills. */
export function bindFlowPreloading(root: Document, preload: (name: string, args?: string) => Promise<void>) {
  const prepare = (event: Event) => {
    const element = (event.target as Element | null)?.closest?.<HTMLElement>("[data-flow]")
    if (!element || element.matches(":disabled, [aria-disabled=true]") || element.closest("[hidden], [inert], [aria-hidden=true]")) return
    // Moving between a button's icon and label is still the same intent.
    if (event instanceof MouseEvent && event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return
    void preload(element.dataset.flow!, element.dataset.flowArgs).catch(() => {})
  }
  for (const event of ["pointerover", "focusin", "pointerdown"]) root.addEventListener(event, prepare)
  return () => { for (const event of ["pointerover", "focusin", "pointerdown"]) root.removeEventListener(event, prepare) }
}
