/** Browser-side operations for the desktop CSS comparison. */
export const captureState = () => ({
  document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
  scroll: { x: scrollX, y: scrollY },
})

export const scrollTo = ({ x, y }: { x: number; y: number }) => {
  window.scrollTo({ left: x, top: y, behavior: "instant" })
}

export const paintAt = async ({ x, y }: { x: number; y: number }) => {
  window.scrollTo({ left: x, top: y, behavior: "instant" })
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  return true
}

type RestorableWindow = Window & { restoreMobileStyles: () => void }

export const removeMobileStyles = (rules: readonly string[]) => {
  const key = (rule: CSSStyleRule) => rule.cssText
  const added = new Set(rules.map((css) => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return key(sheet.cssRules[0] as CSSStyleRule)
  }))
  const undo: Array<() => void> = []
  const visit = (parent: CSSStyleSheet | CSSGroupingRule) => {
    for (let i = parent.cssRules.length - 1; i >= 0; i--) {
      const rule = parent.cssRules[i]!
      if (rule instanceof CSSStyleRule && added.has(key(rule))) {
        const css = rule.cssText
        parent.deleteRule(i)
        undo.unshift(() => parent.insertRule(css, i))
      } else if (rule instanceof CSSGroupingRule) {
        visit(rule)
      }
    }
  }
  for (const sheet of document.styleSheets) visit(sheet)
  ;(window as unknown as RestorableWindow).restoreMobileStyles = () => undo.forEach((restore) => restore())
  return undo.length
}

export const restoreMobileStyles = () => (window as unknown as RestorableWindow).restoreMobileStyles()
