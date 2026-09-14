/*
 * Control focus ("spotlight"): whenever the human is driving one surface —
 * a terminal, a box's desktop, a browser card, a markdown editor — the rest
 * of the app dims and blurs a touch, modal-style, and the surface wears an
 * outset ring. Clicking out releases, exactly like a modal backdrop, and the
 * releasing click never activates what it landed on.
 *
 * The state is one app-level record owned by the controller, never React
 * state and never a journal transition: it is a projection of where focus
 * physically is, changing with every focus event, so persisting it would
 * spam the journal. Components read it through `useSyncExternalStore`
 * (App.tsx renders the dim layer); every surface is detected
 * declaratively from the DOM, so this module is the only authority:
 *
 *  - terminal / desktop / browser surfaces mark their interactive element
 *    with `data-control-focus-id` + `data-control-focus-kind`;
 *  - the markdown editor adapter forwards no attributes, so it is detected
 *    by its own `data-slot="markdown-editor"` root;
 *  - a cross-origin iframe takes focus without any :focus-visible signal
 *    the parent can see (CSS :focus-within and :has(iframe:focus) are all
 *    false for it), so frames are detected the probe-verified way: window
 *    blur + document.activeElement === the iframe.
 *
 * Every marker this module writes is namespaced `data-control-focus*`. The
 * bare `data-controlled` belongs to the onboarding shell, which renders it on
 * every guide bubble (`data-controlled={step === stage}`, stringified by React
 * so even "false" matches a bare attribute selector); sharing the name lifted
 * every bubble above the pinned navigation.
 */

export type ControlFocusKind = "terminal" | "desktop" | "browser" | "editor"

export interface ControlFocus {
  readonly surfaceId: string
  readonly kind: ControlFocusKind
  readonly since: number
}

export interface ControlFocusController {
  /** The `useSyncExternalStore` snapshot: the live record, or null. Stable until a change. */
  readonly snapshot: () => ControlFocus | null
  /** The `useSyncExternalStore` subscribe half. */
  readonly subscribe: (listener: () => void) => () => void
  readonly dispose: () => void
}

const KINDS: ReadonlyArray<ControlFocusKind> = ["terminal", "desktop", "browser", "editor"]

/** What the release affordance calls each surface. A desktop is the user's "box", never a "computer". */
const NOUN: Record<ControlFocusKind, string> = {
  terminal: "terminal",
  desktop: "box",
  browser: "browser",
  editor: "editor"
}

interface Detection {
  readonly element: HTMLElement
  readonly kind: ControlFocusKind
  readonly surfaceId: string
}

/*
 * The swallow listens on the WINDOW in the capture phase, which beats every
 * document-capture listener in the app (runtime/PressActions.ts,
 * SessionNavigation, the tab shortcuts) and React's root handlers.
 * `stopImmediatePropagation` means no other listener — not even another
 * window-capture one registered before us — sees the dismissing gesture.
 */
const SWALLOWED = ["mousedown", "mouseup", "click", "auxclick"] as const

/*
 * A controlled card's own menu, select or confirm dialog is portalled to the
 * body, so it renders outside the surface's subtree while belonging to it.
 * Pressing one is interaction, not dismissal: it neither releases control nor
 * loses its first click. `data-control-focus-portal` is the opt-in for a
 * portal root the list below does not already name.
 */
const PORTAL_ROOTS = [
  "[data-control-focus-portal]",
  "[data-slot='dialog-portal']",
  "[data-slot='dialog-content']",
  "[data-slot='dialog-overlay']",
  "[data-slot='select-content']",
  "[data-slot='tooltip-content']",
  "[data-radix-popper-content-wrapper]",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='listbox']",
  "[role='tooltip']"
].join(", ")

/** How far a finger may travel and still be a tap; past it the gesture is a pan and must scroll. */
const TAP_SLOP = 10
/** How long after a touch the browser's compat mouse tail is still that touch's, not a new press. */
const COMPAT_MS = 500

const asElement = (target: EventTarget | null): Element | null =>
  target !== null && typeof (target as Element).closest === "function" ? (target as Element) : null

const detect = (target: EventTarget | null): Detection | null => {
  const element = asElement(target)
  if (element === null) return null
  const marked = element.closest<HTMLElement>("[data-control-focus-id]")
  if (marked !== null) {
    const kind = marked.getAttribute("data-control-focus-kind") ?? ""
    const surfaceId = marked.getAttribute("data-control-focus-id") ?? ""
    if (!KINDS.includes(kind as ControlFocusKind) || surfaceId === "") return null
    return { element: marked, kind: kind as ControlFocusKind, surfaceId }
  }
  const editor = element.closest<HTMLElement>("[data-slot='markdown-editor']")
  if (editor !== null) {
    const card = editor.closest("[data-testid^='card-']")
    return { element: editor, kind: "editor", surfaceId: `editor:${card?.getAttribute("data-testid") ?? "pane"}` }
  }
  return null
}

export const createControlFocus = (doc: Document | undefined): ControlFocusController => {
  let current: { readonly state: ControlFocus; readonly anchor: HTMLElement } | null = null
  const listeners = new Set<() => void>()
  /*
   * The dismissal gesture in flight, keyed to the pointer that started it: its
   * whole tail (mousedown, pointerup, mouseup, click) is swallowed, so the
   * press that dismissed never reaches the control underneath — only the NEXT
   * one does. It is never a sticky boolean waiting for a click that may never
   * come: a right press, a middle press, a release past the window edge and a
   * cancelled touch all end it, and so does the next press.
   */
  let armed: { readonly pointerId: number | null; sawMouseDown: boolean } | null = null
  /*
   * The press in flight: where it began, and whether it began inside the
   * surface — a drag that starts inside (selecting terminal text out past the
   * edge) never dismisses. It outlives the pointerup, because the mouse tail
   * that follows (mouseup, then the click the browser fires on the common
   * ancestor of press and release) has to know where the press began too.
   */
  let gesture: { readonly pointerId: number | null; readonly inside: boolean; readonly touch: boolean; readonly x: number; readonly y: number; sawMouseDown: boolean } | null = null
  /* Until when the browser's compat mouse tail still belongs to a finished touch. */
  let compatUntil = 0
  /* The trapping scrollers hosting the surface, innermost first, each with the dim drawn inside it. */
  let scoped: Array<{ readonly host: HTMLElement; readonly dim: HTMLDivElement; readonly reanchors: boolean }> = []
  /* The "Release control" button mounted beside the ringed surface while it is controlled. */
  let releaseButton: HTMLButtonElement | null = null
  /* The element we lent a tab stop to for one focus move, so it can be taken back. */
  let borrowedTabStop: HTMLElement | null = null
  let observer: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const isInside = (target: Element | null): boolean => {
    if (target === null || current === null) return false
    return current.anchor.contains(target) || target.closest(PORTAL_ROOTS) !== null
  }

  /*
   * What re-anchors position:fixed or caps a descendant's z-index (the
   * probe-verified list): contain layout/paint, any filter, backdrop-filter,
   * any transform, perspective, will-change: transform, content-visibility —
   * and the stacking-context triggers that only cap z-index without
   * re-anchoring: mask-image, isolation, mix-blend-mode, opacity below 1, and
   * a positioned ancestor carrying its own z-index. A card under any of these
   * can never rise above the shell's dim layer, so the dim is drawn inside
   * that same scroller and the scroller itself is lifted.
   */
  const isSet = (value: string): boolean => value !== "" && value !== "none" && value !== "normal"

  /*
   * The transcript's viewport always carries @smthrs/ui's `.sui-scroll-fade`
   * class, but the mask only paints while a fade edge is showing (uiCss.ts
   * keys it off the data attributes), and only a painted mask traps. The class
   * is read by name so detection does not depend on mask support in test DOMs.
   */
  const masked = (element: HTMLElement, style: CSSStyleDeclaration): boolean => {
    if (element.classList.contains("sui-scroll-fade")) {
      return element.getAttribute("data-fade-top") === "true" || element.getAttribute("data-fade-bottom") === "true"
    }
    return isSet(style.maskImage)
  }

  const traps = (element: HTMLElement, win: Window): { readonly trapped: boolean; readonly reanchors: boolean } => {
    const style = win.getComputedStyle(element)
    if (isSet(style.transform) || isSet(style.filter) || isSet(style.backdropFilter) || style.willChange.includes("transform")) {
      return { trapped: true, reanchors: true }
    }
    if (style.contain.includes("layout") || style.contain.includes("paint") || style.contain.includes("strict") || style.contain.includes("content")) {
      return { trapped: true, reanchors: true }
    }
    if (style.contentVisibility === "hidden" || style.contentVisibility === "auto") return { trapped: true, reanchors: true }
    if (isSet(style.perspective)) return { trapped: true, reanchors: true }
    if (masked(element, style)) return { trapped: true, reanchors: false }
    if (style.isolation === "isolate") return { trapped: true, reanchors: false }
    if (isSet(style.mixBlendMode)) return { trapped: true, reanchors: false }
    const opacity = Number.parseFloat(style.opacity)
    if (Number.isFinite(opacity) && opacity < 1) return { trapped: true, reanchors: false }
    if (style.position !== "" && style.position !== "static" && style.zIndex !== "" && style.zIndex !== "auto") {
      return { trapped: true, reanchors: false }
    }
    return { trapped: false, reanchors: false }
  }

  /*
   * EVERY trapping ancestor is a host, innermost first: stopping at the first
   * one leaves an outer trap capping the lifted scroller just as it capped the
   * card. Each host lifts inside its parent's stacking context and carries its
   * own dim, so every region is dimmed exactly once.
   */
  const findTrapHosts = (anchor: HTMLElement, win: Window): Array<{ readonly host: HTMLElement; readonly reanchors: boolean }> => {
    const hosts: Array<{ readonly host: HTMLElement; readonly reanchors: boolean }> = []
    const shell = anchor.closest(".app-shell")
    for (let element = anchor.parentElement; element !== null && element !== win.document.body && element !== shell; element = element.parentElement) {
      const { trapped, reanchors } = traps(element, win)
      if (trapped) hosts.push({ host: element, reanchors })
    }
    return hosts
  }

  const fitScopedDims = (): void => {
    for (const { host, dim, reanchors } of scoped) {
      /*
       * The scoped dim is fixed but pinned to the scroller's box. When the
       * host re-anchors fixed to itself, inset:0 IS the box. When it only
       * caps z-index (the mask case), fixed stays viewport-anchored: inset:0
       * would double-dim the whole window (the shell already carries one), so
       * the layer is pinned to the scroller's viewport rect — the mask clips
       * it to the same box anyway. A ResizeObserver keeps it fitted, so a pane
       * opening or a breakpoint change no longer leaves it misaligned.
       */
      if (reanchors) {
        dim.style.inset = "0"
        continue
      }
      const rect = host.getBoundingClientRect()
      dim.style.top = `${rect.top}px`
      dim.style.left = `${rect.left}px`
      dim.style.width = `${rect.width}px`
      dim.style.height = `${rect.height}px`
    }
  }

  const clearScoped = (): void => {
    for (const { host, dim } of scoped) {
      dim.remove()
      host.removeAttribute("data-control-focus-host")
    }
    scoped = []
  }

  /*
   * The tab stop is borrowed, not granted: an element that had none gets
   * `tabindex="-1"` only for as long as it holds this focus, so releasing
   * never leaves a stray programmatic focus target behind in the transcript.
   */
  const dropBorrowedTabStop = (): void => {
    if (borrowedTabStop === null) return
    borrowedTabStop.removeAttribute("tabindex")
    borrowedTabStop.removeEventListener("focusout", onBorrowerFocusOut)
    borrowedTabStop = null
  }

  /* Only the borrower's own focusout ends the loan; a descendant's (the frame it holds) bubbles through it. */
  const onBorrowerFocusOut = (event: Event): void => {
    if (event.target === borrowedTabStop) dropBorrowedTabStop()
  }

  const focusSurfaceHome = (anchor: HTMLElement): void => {
    /*
     * Focus moves explicitly to the surface's card section or tab body —
     * never to body: ChatCards.tsx records that focus on body breaks the
     * shell's Escape. `preventScroll` keeps the release from yanking the
     * transcript to the card the user was already looking at.
     */
    const target = anchor.closest<HTMLElement>(".smithers-card, .tab-body") ?? anchor
    if (!target.hasAttribute("tabindex")) {
      dropBorrowedTabStop()
      borrowedTabStop = target
      target.setAttribute("tabindex", "-1")
      target.addEventListener("focusout", onBorrowerFocusOut)
    }
    target.focus({ preventScroll: true })
  }

  const clear = (refocus: boolean): void => {
    if (current === null) return
    const { anchor } = current
    current = null
    anchor.removeAttribute("data-control-focus")
    releaseButton?.remove()
    releaseButton = null
    clearScoped()
    observer?.disconnect()
    observer = null
    resizeObserver?.disconnect()
    resizeObserver = null
    notify()
    if (refocus) focusSurfaceHome(anchor)
  }

  /*
   * A focused cross-origin frame consumes every key, so no chord can reach
   * this document, and xterm swallows Tab. Keyboard-only operation is a
   * product rule (apps/app/AGENTS.md), so the ring carries its own way out: a
   * small, quiet button in the surface's own corner, reachable by Tab and
   * activated by Enter like any other button.
   */
  const mountReleaseButton = (anchor: HTMLElement, kind: ControlFocusKind): void => {
    if (doc === undefined) return
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "sui-button sui-button-ghost sui-button-sm control-focus-release"
    button.setAttribute("data-control-focus-release", "")
    button.setAttribute("aria-label", `Release control of the ${NOUN[kind]}`)
    button.textContent = "Release control"
    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      clear(true)
    })
    anchor.append(button)
    releaseButton = button
  }

  /*
   * A surface that unmounts while controlled releases silently — there is
   * nowhere to return focus to. The watch is childList on the anchor's own
   * ancestor chain, never a document-wide subtree: removing the anchor, or any
   * ancestor, is a childList mutation on that node's parent, so this sees
   * every unmount without the whole document's traffic running through a
   * callback for as long as a surface is controlled.
   */
  const watchForUnmount = (anchor: HTMLElement): void => {
    observer = new MutationObserver(() => {
      if (current !== null && !current.anchor.isConnected) clear(false)
    })
    for (let element = anchor.parentElement; element !== null; element = element.parentElement) {
      observer.observe(element, { childList: true })
    }
  }

  const enter = (detection: Detection): void => {
    if (current?.state.surfaceId === detection.surfaceId) return
    clear(false)
    /*
     * The ring dresses the box the surface sits in — the card for card
     * surfaces, the terminal root itself for a tab.
     */
    const anchor = detection.element.closest<HTMLElement>(".smithers-card") ?? detection.element
    current = { state: { surfaceId: detection.surfaceId, kind: detection.kind, since: Date.now() }, anchor }
    anchor.setAttribute("data-control-focus", "human")
    const win = doc?.defaultView ?? null
    if (doc !== undefined && win !== null) {
      /*
       * A trapping ancestor (the transcript viewport's mask, the lesson
       * mount's contain:layout) caps its descendants' z-index, so a card
       * inside it can never rise above the shell's dim layer. While it hosts
       * the controlled surface the scroller itself lifts and carries a dim
       * inside its own stacking context; the card lifts one step further
       * within it. Hover and wheel pass through every layer (pointer-events: none).
       */
      for (const { host, reanchors } of findTrapHosts(anchor, win)) {
        const dim = doc.createElement("div")
        dim.className = "control-focus-dim control-focus-dim--scoped"
        dim.setAttribute("aria-hidden", "true")
        host.setAttribute("data-control-focus-host", "")
        host.append(dim)
        scoped.push({ host, dim, reanchors })
      }
      fitScopedDims()
      if (typeof win.ResizeObserver === "function" && scoped.length > 0) {
        resizeObserver = new win.ResizeObserver(() => fitScopedDims())
        for (const { host } of scoped) resizeObserver.observe(host)
      }
      mountReleaseButton(anchor, detection.kind)
      watchForUnmount(anchor)
    }
    notify()
  }

  const onFocusIn = (event: Event): void => {
    const detection = detect(event.target)
    if (detection !== null) {
      enter(detection)
      return
    }
    if (current === null) return
    if (isInside(asElement(event.target))) return
    /*
     * Focus arrived somewhere else entirely. A cross-origin frame fires no
     * focusout in this document, so tabbing out of one is only visible as the
     * focus that arrives; without this, control stayed lit over a surface the
     * user had already left. Release without stealing focus back.
     */
    clear(false)
  }

  const onFocusOut = (event: FocusEvent): void => {
    if (current === null) return
    if (isInside(asElement(event.relatedTarget))) return
    /* Focus left the surface (⌘K, a tab shortcut, a programmatic move): release without stealing focus back. */
    clear(false)
  }

  const onWindowBlur = (): void => {
    /* Whatever gesture was in flight cannot finish now: never leave the swallow armed for the next click. */
    armed = null
    const active = doc?.activeElement ?? null
    if (active === null || active.tagName !== "IFRAME") return
    const detection = detect(active)
    if (detection !== null) enter(detection)
  }

  const eat = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const now = (): number => Date.now()

  /** The compat mouse tail a finished touch synthesizes is that touch's, never a new press. */
  const compatTail = (): boolean => now() < compatUntil

  const onPointerDown = (event: PointerEvent): void => {
    /* A fresh press ends any gesture still armed: whatever tail was expected never arrived. */
    armed = null
    gesture = null
    /* Only a real gesture dismisses; the press arbiter's own synthetic events are not the user's hand. */
    if (!event.isTrusted || current === null) return
    const target = asElement(event.target)
    const inside = isInside(target)
    gesture = { pointerId: event.pointerId, inside, touch: event.pointerType === "touch", x: event.clientX, y: event.clientY, sawMouseDown: false }
    if (inside) return
    /*
     * A touch is decided at pointerup: a tap dismisses, but a pan must still
     * scroll the dimmed content, so the pointerdown itself is left alone.
     */
    if (gesture.touch) return
    if (event.button !== 0) {
      /* A right or middle press releases, but arms nothing: no click follows it to disarm the swallow. */
      clear(true)
      return
    }
    eat(event)
    armed = { pointerId: event.pointerId, sawMouseDown: false }
    clear(true)
  }

  const onPointerUp = (event: PointerEvent): void => {
    const held = gesture
    if (held !== null && held.touch) compatUntil = now() + COMPAT_MS
    if (armed !== null) {
      if (armed.pointerId === null || armed.pointerId === event.pointerId) {
        /* The dismissing press's release belongs to the swallowed gesture: the press arbiter must not see it. */
        eat(event)
        return
      }
      armed = null
    }
    if (!event.isTrusted || current === null) return
    if (held === null || held.pointerId !== event.pointerId || held.inside || !held.touch) return
    /*
     * A touch release is a tap only within a finger's slop of where it began.
     * Past that it was a pan — the app kept the pointer and delivered
     * pointerup rather than pointercancel — and a pan must scroll, not dismiss.
     */
    if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > TAP_SLOP) return
    eat(event)
    armed = { pointerId: event.pointerId, sawMouseDown: false }
    clear(true)
  }

  const onPointerCancel = (): void => {
    if (gesture !== null && gesture.touch) compatUntil = now() + COMPAT_MS
    gesture = null
    armed = null
  }

  /* No click follows a right press, so the context menu is where that gesture ends. */
  const onContextMenu = (): void => {
    armed = null
  }

  const onGestureTail = (event: MouseEvent): void => {
    if (armed !== null) {
      if (event.type !== "mousedown") {
        eat(event)
        if (event.type === "click" || event.type === "auxclick") armed = null
        return
      }
      if (!armed.sawMouseDown) {
        armed.sawMouseDown = true
        eat(event)
        return
      }
      /* A second press with the first still armed: that gesture is over, let this one through. */
      armed = null
    }
    if (!event.isTrusted || current === null || compatTail()) return
    const target = asElement(event.target)
    const inside = isInside(target)
    let held = gesture
    if (event.type === "mousedown") {
      if (held !== null && !held.sawMouseDown) {
        /* This press's own pointerdown already decided it: inside, a touch, or a dismissal. */
        held.sawMouseDown = true
        return
      }
      /* A mouse path with no pointer events at all still records where the press began. */
      held = { pointerId: null, inside, touch: false, x: event.clientX, y: event.clientY, sawMouseDown: true }
      gesture = held
    }
    if (event.type === "click" || event.type === "auxclick") gesture = null
    /*
     * The press began inside the surface: this is a drag out of it (selecting
     * terminal text past the edge), never a dismissal. The pointer path always
     * guarded this; the mouse tail did not, and released on every such drag.
     */
    if (held !== null && held.inside) return
    if (inside) return
    if (event.button !== 0) {
      clear(true)
      return
    }
    eat(event)
    armed = { pointerId: null, sawMouseDown: event.type === "mousedown" }
    clear(true)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (current === null || event.key !== "Escape") return
    /*
     * Meta-Escape (or Ctrl-Escape: the app's own chords take either) is the
     * release chord. Plain Escape releases only the editor: a terminal cancels
     * Escape itself and a cross-origin frame never lets any key reach this
     * document at all — that surface is released with the ring's own
     * "Release control" button.
     */
    if (!event.metaKey && !event.ctrlKey && current.state.kind !== "editor") return
    eat(event)
    clear(true)
  }

  const onResize = (): void => fitScopedDims()

  const win = doc?.defaultView ?? null
  if (doc !== undefined && win !== null) {
    /*
     * Every listener rides the WINDOW's capture phase: window capture runs
     * before the document-capture listeners the rest of the app installed
     * (runtime/PressActions.ts, SessionNavigation, the tab shortcuts), so
     * the dismissing gesture is gone before any of them could see it.
     */
    win.addEventListener("focusin", onFocusIn, true)
    win.addEventListener("focusout", onFocusOut, true)
    win.addEventListener("pointerdown", onPointerDown, true)
    win.addEventListener("pointerup", onPointerUp, true)
    win.addEventListener("pointercancel", onPointerCancel, true)
    win.addEventListener("contextmenu", onContextMenu, true)
    for (const type of SWALLOWED) win.addEventListener(type, onGestureTail as EventListener, true)
    win.addEventListener("keydown", onKeyDown, true)
    win.addEventListener("blur", onWindowBlur)
    win.addEventListener("resize", onResize)
  }

  return {
    snapshot: () => current?.state ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      clear(false)
      dropBorrowedTabStop()
      armed = null
      gesture = null
      if (doc !== undefined && win !== null) {
        win.removeEventListener("focusin", onFocusIn, true)
        win.removeEventListener("focusout", onFocusOut, true)
        win.removeEventListener("pointerdown", onPointerDown, true)
        win.removeEventListener("pointerup", onPointerUp, true)
        win.removeEventListener("pointercancel", onPointerCancel, true)
        win.removeEventListener("contextmenu", onContextMenu, true)
        for (const type of SWALLOWED) win.removeEventListener(type, onGestureTail as EventListener, true)
        win.removeEventListener("keydown", onKeyDown, true)
        win.removeEventListener("blur", onWindowBlur)
        win.removeEventListener("resize", onResize)
      }
    }
  }
}
