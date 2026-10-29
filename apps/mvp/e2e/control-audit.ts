import type { Locator } from "@playwright/test"

export type Finding = { element: string; problem: string }
export const CONTROL_SELECTOR = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [contenteditable="true"]'

/** A single browser turn keeps the DOM snapshot stable and avoids a protocol round trip for every check. */
export const auditControls = (controls: Locator) => controls.evaluateAll((elements) => {
  const findings: Finding[] = []
  let checked = 0
  for (const element of elements) {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const keyboardOnly = getComputedStyle(element).clipPath === "inset(50%)"
    if (keyboardOnly) (element as HTMLElement).focus()
    // Scroll and measure in one browser turn: a live list may replace this
    // control between separate scroll and measurement calls.
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
    // Scrolling to the latest message legitimately hides its jump button.
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      if (keyboardOnly) (element as HTMLElement).blur()
      continue
    }
    const rect = element.getBoundingClientRect()
    const name = `${element.tagName.toLowerCase()}.${element.className} ${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? ""}`
    const errors: Finding[] = []
    if (innerWidth <= 960 && (rect.width < 32 || rect.height < 32)) errors.push({ element: name, problem: `tap target ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}` })
    if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) errors.push({ element: name, problem: `outside viewport ${JSON.stringify(rect.toJSON())}` })
    // An inline link can wrap: its bounding-box center may be empty space
    // between fragments. Check every actual fragment, not that empty space.
    for (const fragment of element.getClientRects()) {
      const insetX = Math.min(4, fragment.width / 4)
      const insetY = Math.min(4, fragment.height / 4)
      const points = [
        [fragment.x + fragment.width / 2, fragment.y + fragment.height / 2],
        [fragment.left + insetX, fragment.top + fragment.height / 2],
        [fragment.right - insetX, fragment.top + fragment.height / 2],
        [fragment.left + fragment.width / 2, fragment.top + insetY],
        [fragment.left + fragment.width / 2, fragment.bottom - insetY],
      ]
      for (const [x, y] of points) {
        const top = document.elementFromPoint(x!, y!)
        if (top !== element && !element.contains(top)) {
          errors.push({ element: name, problem: `covered by ${top?.tagName}.${top?.className}` })
          break
        }
      }
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const box = parent.getBoundingClientRect()
        const left = box.left + parent.clientLeft
        const top = box.top + parent.clientTop
        const clips = (overflow: string) => ["hidden", "clip", "auto", "scroll"].includes(overflow)
        if ((clips(style.overflowX) && (fragment.left < left - 1 || fragment.right > left + parent.clientWidth + 1)) ||
            (clips(style.overflowY) && (fragment.top < top - 1 || fragment.bottom > top + parent.clientHeight + 1))) {
          errors.push({ element: name, problem: `clipped by ${parent.tagName}.${parent.className}` })
        }
      }
    }
    findings.push(...errors)
    checked++
    if (keyboardOnly) (element as HTMLElement).blur()
  }
  return { selected: elements.length, checked, findings }
})
