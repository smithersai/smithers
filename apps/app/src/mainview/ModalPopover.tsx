import { useCallback, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { placeToast } from "./ToastPlacement"

const controlsSelector = 'button, input, textarea, select, a[href], summary, [contenteditable="true"], [role="button"], [tabindex]'
const visible = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && element.checkVisibility()
}

/** Ignore streamed text and ordinary DOM churn before scanning modal state. */
const changesDialogs = (record: MutationRecord) => record.type === "attributes"
  ? record.target instanceof HTMLDialogElement
  : [...record.addedNodes, ...record.removedNodes].some(node =>
    node instanceof Element && (node.matches("dialog") || node.querySelector("dialog") !== null))

/** A persistent portal that remains interactive above any native modal. */
export function ModalPopover({ children, className, label, onMount }: {
  children: ReactNode
  className: string
  label: string
  onMount?: (node: HTMLDivElement) => () => void
}) {
  const [host] = useState(() => document.createElement("div"))
  const mount = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const doc = node.ownerDocument
    host.setAttribute("data-modal-popover", "")
    let opened: HTMLDialogElement[] = []
    let modal: HTMLDialogElement | undefined
    let measuredContent: Element | undefined
    let frame = 0
    const position = () => {
      cancelAnimationFrame(frame)
      frame = 0
      for (const property of ["--toast-x", "--toast-y", "--toast-height"]) node.style.removeProperty(property)
      node.removeAttribute("data-no-toast-space")
      node.toggleAttribute("data-modal-placement", modal !== undefined)
      if (!modal) return
      // Ordinary dialogs own their box. Full-viewport shells own a scrim: use
      // their first visible element with a layout box (excluding our portal).
      // All controls are still obstacles, including siblings outside that box.
      const dialogRect = modal.getBoundingClientRect()
      const content = dialogRect.width >= doc.documentElement.clientWidth && dialogRect.height >= doc.documentElement.clientHeight
        ? [...modal.children].find(child => child !== host && visible(child)) ?? modal : modal
      if (content !== measuredContent) {
        if (measuredContent && measuredContent !== modal) resize.unobserve(measuredContent)
        measuredContent = content
        resize.observe(content)
      }
      const style = getComputedStyle(node)
      const gap = parseFloat(style.getPropertyValue("--toast-gap"))
      const top = parseFloat(style.top)
      // Use the bottom viewport gutter before resorting to an overlay. A short
      // landscape window can fit the whole toast below the modal only this way.
      const rect = placeToast({ x: gap, y: top, width: doc.documentElement.clientWidth - gap * 2,
        height: doc.documentElement.clientHeight - top }, node.getBoundingClientRect(), content.getBoundingClientRect(),
        [...modal.querySelectorAll(controlsSelector)].filter(control => !host.contains(control) && visible(control))
          .map(control => control.getBoundingClientRect()), gap)
      if (!rect) { node.setAttribute("data-no-toast-space", ""); return }
      node.style.setProperty("--toast-x", `${rect.x}px`)
      node.style.setProperty("--toast-y", `${rect.y}px`)
      node.style.setProperty("--toast-height", `${rect.height}px`)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position) }
    const moved = (event: Event) => { if (modal && event.target instanceof Node && modal.contains(event.target) && !host.contains(event.target)) schedule() }
    const resize = new ResizeObserver(schedule)
    resize.observe(node)
    // A height-limited stack does not resize when another notification arrives.
    const toastChanges = new MutationObserver(schedule)
    toastChanges.observe(node, { subtree: true, childList: true, characterData: true })
    const contentChanges = new MutationObserver(records => {
      if (records.some(record => !host.contains(record.target))) schedule()
    })
    // Native dialog state is external to React. Observe it at the portal's ref
    // boundary; moving its stable host preserves the mounted children and handlers.
    const sync = (records: MutationRecord[] = []) => {
      const modals = [...doc.querySelectorAll<HTMLDialogElement>("dialog:modal")]
      opened = [...opened.filter(dialog => modals.includes(dialog)), ...modals.filter(dialog => !opened.includes(dialog))]
      // Mutation order also covers several dialogs opened in the same task.
      for (const record of records) {
        const dialog = record.target as HTMLDialogElement
        if (record.attributeName === "open" && modals.includes(dialog)) {
          opened = [...opened.filter(other => other !== dialog), dialog]
        }
      }
      // If notifications arrive after a modal opened, its focused descendant
      // identifies the active dialog even when DOM order differs from open order.
      const focused = doc.activeElement?.closest<HTMLDialogElement>("dialog:modal")
      if (focused && modals.includes(focused)) opened = [...opened.filter(dialog => dialog !== focused), focused]
      const active = opened.at(-1)
      if (active !== modal) {
        modal = active
        resize.disconnect()
        measuredContent = undefined
        resize.observe(node)
        contentChanges.disconnect()
        if (modal) {
          resize.observe(modal)
          contentChanges.observe(modal, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden"] })
        }
      }
      const parent = modal ?? doc.body
      if (host.parentElement !== parent) parent.append(host)
      // Popovers alone remain inert outside a modal. Inside it they also escape
      // clipping, transforms and backdrop filters through the browser's top layer.
      if (node.showPopover && !node.matches(":popover-open")) node.showPopover()
      position()
    }
    sync()
    const cleanup = onMount?.(node)
    const observer = new MutationObserver(records => {
      const relevant = records.filter(changesDialogs)
      if (relevant.length) sync(relevant)
    })
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] })
    window.addEventListener("resize", schedule)
    // Scroll and completed transitions can move a box without resizing it.
    doc.addEventListener("scroll", moved, true)
    doc.addEventListener("transitionend", moved, true)
    doc.addEventListener("animationend", moved, true)
    return () => {
      observer.disconnect()
      toastChanges.disconnect()
      contentChanges.disconnect()
      resize.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", schedule)
      doc.removeEventListener("scroll", moved, true)
      doc.removeEventListener("transitionend", moved, true)
      doc.removeEventListener("animationend", moved, true)
      cleanup?.()
      host.remove()
    }
  }, [host, onMount])
  return createPortal(<div ref={mount} popover="manual" className={className} aria-label={label}>{children}</div>, host)
}
