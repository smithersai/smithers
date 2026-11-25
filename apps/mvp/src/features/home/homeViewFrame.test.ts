import { describe, expect, test } from "vitest"
import { isOfferedHomeFlow } from "./components/HomeViewFrame.tsx"
import { renderHomeViewFrame } from "./homeViewFrame-render.tsx"

describe("HomeViewFrame and repo-local flow matching", () => {
  test("matches both built-in commands and repo-local playground flows", () => {
    const builtIn = (name: string) => name === "branch.new"
    const repoFlows = [{ name: "playground/exec" }, { name: "checks/review" }]
    expect(isOfferedHomeFlow("branch.new", builtIn, repoFlows)).toBe(true)
    expect(isOfferedHomeFlow("playground/exec", builtIn, repoFlows)).toBe(true)
    expect(isOfferedHomeFlow("playground.exec", builtIn, repoFlows)).toBe(true)
    expect(isOfferedHomeFlow("unknown.flow", builtIn, repoFlows)).toBe(false)
  })

  test("renders host-owned framed-app PaneFrame with clean copy", () => {
    const html = renderHomeViewFrame("playground.exec")
    expect(html).toContain('data-pane-origin="framed-app"')
    expect(html).toContain("Sandboxed app")
    expect(html).toContain("playground.exec")
    expect(html).toContain("Open view")
    const visibleText = html.replace(/<[^>]+>/g, " ").replace(/&(gt|lt|amp|quot|#x27);/g, "")
    expect(visibleText).not.toContain(";")
    expect(visibleText).not.toContain("—")
    expect(visibleText.toLowerCase()).not.toContain("jjhub")
  })
})
