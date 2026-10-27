/** @jsxImportSource react */
import { useLayoutEffect, useRef } from "react"

// Runs after the router commits the new screen. Search/filter changes keep focus
// on their control; only a different page moves it into the new content.
export function PageFocus({ pathname }: { readonly pathname: string }) {
  const previous = useRef(pathname)
  useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>("main")
    if (main !== null) {
      main.id = "main-content"
      main.tabIndex = -1
      if (previous.current !== pathname) {
        const heading = main.querySelector<HTMLElement>("h1")
        const preferred = main.querySelector<HTMLElement>("[data-page-focus] input")
        const target = preferred ?? heading ?? main
        if (preferred === null) target.tabIndex = -1
        target.focus({ preventScroll: true })
      }
    }
    previous.current = pathname
  }, [pathname])
  return null
}
