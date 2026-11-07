/** A scroll event measures the reader's position, independently of later transcript growth. */
export function atBottom(document: Document): boolean {
  const viewport = document.documentElement
  return viewport.scrollHeight - viewport.clientHeight - (document.defaultView?.scrollY ?? 0) <= 48
}

/** One subscription host owns this permission. Invalidate it on the native input stack, before queued messages,
 * renders or afterCommit continuations can run. A model carrying an older intent can never authorize a scroll. */
export function transcriptViewport(page?: Document) {
  let intent = 0
  let paused = false
  let previousY = page?.defaultView?.scrollY ?? 0
  let touch: { id: number; y: number } | undefined
  const active = () => !page || (
    page.querySelector(".vl-app[data-surface='chat']") !== null &&
    page.querySelector("#vl-palette[data-state='open']") === null
  )
  const position = () => page?.defaultView?.scrollY ?? 0
  const pause = () => {
    if (!active()) return undefined
    paused = true
    previousY = position()
    return { bottom: false, intent: ++intent }
  }
  return {
    wheel: (event: WheelEvent) => event.deltaY < 0 && !event.ctrlKey ? pause() : undefined,
    key: (event: KeyboardEvent) => {
      if (event.defaultPrevented ||
        !["PageUp", "Home", "ArrowUp"].includes(event.key)) return undefined
      const target = event.target as Element | null
      // Cursor navigation and scrolling inside an editor belong to that control.
      if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return undefined
      return pause()
    },
    touchStart: (event: TouchEvent) => {
      const first = event.touches[0]
      touch = active() && first ? { id: first.identifier, y: first.clientY } : undefined
    },
    touchMove: (event: TouchEvent) => {
      const current = Array.from(event.touches).find(item => item.identifier === touch?.id)
      if (!touch || !current) return undefined
      const upward = current.clientY > touch.y
      touch = { id: current.identifier, y: current.clientY }
      return upward ? pause() : undefined
    },
    touchEnd: () => { touch = undefined },
    scrolled: () => {
      if (!active()) return undefined
      const y = position()
      const bottom = (!page || atBottom(page)) && (!paused || y > previousY)
      if (!bottom && !paused) { paused = true; intent++ }
      if (bottom) paused = false
      previousY = y
      return { bottom, intent }
    },
    follow: (authorizedIntent: number) => {
      // Check permission and perform the native write in one synchronous body: no fiber yield between them.
      if (authorizedIntent !== intent || !active()) return
      const newest = page?.querySelector<HTMLElement>("[data-following='true'] #vl-newest")
      if (!newest) return
      paused = false
      newest.scrollIntoView({ block: "end" })
    },
  }
}
