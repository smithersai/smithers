import { useEffect, useRef, type RefObject } from "react";

/**
 * Everything the browser will hand a Tab to.
 *
 * `contenteditable` and `iframe` matter most here: a rich-text surface (this
 * package ships one) is a real tab stop, and leaving it out of the list made
 * the focused editor neither the computed first nor the computed last element,
 * so the handler below preventDefault-ed nothing and native Tab walked focus
 * straight out of the dialog.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "audio[controls]",
  "video[controls]",
  "details > summary",
  "[contenteditable]:not([contenteditable='false'])",
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const activeDialogStack: HTMLElement[] = [];

/**
 * The container's focusable elements, in document order, minus the ones the
 * browser will not actually focus: `tabindex="-1"`, anything under an `inert`
 * or `aria-hidden="true"` subtree, and anything with no box (`display:none`,
 * a closed `details`, a collapsed panel). Wrapping focus onto a hidden control
 * would send it somewhere the user cannot see.
 */
function isRendered(element: HTMLElement, container: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  const own = view.getComputedStyle(element);
  if (own.visibility === "hidden" || own.visibility === "collapse") return false;
  // Walk ancestors by hand rather than trusting `checkVisibility` or layout
  // (`offsetParent`, `getClientRects`): layout-free DOMs report no box for
  // every node, and not every DOM implements `checkVisibility`.
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || view.getComputedStyle(node).display === "none") return false;
    const parent: HTMLElement | null = node.parentElement;
    // Only a closed `details`' own summary stays rendered.
    if (parent instanceof view.HTMLDetailsElement && !parent.open && !(node.tagName === "SUMMARY" && parent.querySelector(":scope > summary") === node)) {
      return false;
    }
    if (node === container) break;
  }
  return true;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.closest("[inert],[aria-hidden='true']")) return false;
    if (!isRendered(element, container)) return false;
    // Read the ATTRIBUTE, not the `tabIndex` property. The selector already
    // matches only natively focusable elements plus an explicit positive
    // `tabindex`, and the property is unreliable across DOM implementations:
    // a `contenteditable` host reports 0 in a browser and -1 in happy-dom, so
    // a property test silently dropped the one element kind this trap most
    // needs to contain.
    const declared = element.getAttribute("tabindex");
    if (declared !== null && !(Number.parseInt(declared, 10) >= 0)) return false;
    return true;
  });
}

function removeDialogFromStack(container: HTMLElement) {
  const index = activeDialogStack.lastIndexOf(container);
  if (index >= 0) activeDialogStack.splice(index, 1);
}

export type UseDialogFocusTrapOptions = {
  /** Set false to suspend the trap without unmounting the dialog. */
  active?: boolean;
  /** The dialog container; give it `tabIndex={-1}` so it can take focus when empty. */
  containerRef: RefObject<HTMLElement | null>;
  /** Focused on open; defaults to the first focusable element in the container. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Called when Escape is pressed while this dialog is top-most. */
  onClose: () => void;
};

/**
 * Trap focus inside the top-most dialog, close on Escape, and restore the
 * element that opened it. Stacked modals are supported: only the last mounted
 * (or re-activated) dialog responds to keyboard and focus events.
 */
export function useDialogFocusTrap({
  active = true,
  containerRef,
  initialFocusRef,
  onClose,
}: UseDialogFocusTrapOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const container = containerRef.current;
    if (!container) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeDialogStack.push(container);

    const isTopDialog = () => activeDialogStack.at(-1) === container;
    const focusInitial = () => {
      const target = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
      target.focus();
    };

    // Keep the handle: cleanup must cancel a still-pending frame or it would
    // steal focus back into a suspended/closed dialog after focus was
    // restored to the opener.
    const initialFocusRaf = window.requestAnimationFrame(focusInitial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      } else if (!container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopDialog()) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && container.contains(target)) return;
      focusInitial();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.cancelAnimationFrame(initialFocusRaf);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      removeDialogFromStack(container);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, containerRef, initialFocusRef]);
}
