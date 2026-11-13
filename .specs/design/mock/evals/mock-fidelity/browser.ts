import { createRequire } from "node:module"
import { access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Page } from "../../../../../apps/app/node_modules/@playwright/test/index"
import { appliesToSite, requiredStatesFor, routeProblemsFor, screensFor, statesFor, type CaseOutput, type Observation, type PageEvidence, type SitePayload, type ViewSpec } from "./scoring.ts"

const here = dirname(fileURLToPath(import.meta.url))
export const mockRoot = resolve(here, "../..")
export const repoRoot = resolve(here, "../../../../..")
interface BrowserSite extends SitePayload { resolve: (route: string) => string | null }
declare global { interface Window { __SITE__: BrowserSite } }

/** Copied from crawl.mjs: that script launches at module load and cannot be imported. */
export const auditPage = (): string[] => {
  const problems: string[] = []
  const site = window.__SITE__
  const label = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
  for (const a of document.querySelectorAll("a")) {
    if (a.closest("[data-mock]")) continue
    const href = a.getAttribute("href")
    if (href === null || href === "" || href === "#") { problems.push(`dead link "${label(a)}"`); continue }
    if (href.startsWith("#/")) {
      if (!site.resolve(href.slice(2))) problems.push(`link "${label(a)}" to unknown route ${href}`)
    } else if (/^https?:/.test(href)) {
      if (a.getAttribute("target") !== "_blank") problems.push(`external link "${label(a)}" without target=_blank`)
    } else if (!href.startsWith("mailto:")) problems.push(`link "${label(a)}" with unsupported href ${href}`)
    if (label(a) === "" && a.querySelector("img[alt]") === null) problems.push(`link to ${href} has no name`)
  }
  for (const button of document.querySelectorAll("button")) {
    if (button.closest("[data-mock]")) continue
    if (label(button) === "") problems.push("button with no name")
    const props = Object.keys(button).find(key => key.startsWith("__reactProps"))
    const handlers = props ? (button as unknown as Record<string, { onClick?: unknown }>)[props] : undefined
    const handled = props !== undefined && (typeof handlers?.onClick === "function" || (button.type === "submit" && button.form !== null) || button.disabled)
    if (!handled && !button.hasAttribute("data-inert")) problems.push(`button "${label(button)}" does nothing`)
  }
  for (const input of document.querySelectorAll<HTMLInputElement>("input:not([type=hidden]), textarea, select")) {
    if (input.closest("[data-mock]")) continue
    if (!(input.getAttribute("aria-label") || input.labels?.length || input.getAttribute("aria-labelledby"))) {
      problems.push(`field ${input.name || input.placeholder || input.tagName} has no label`)
    }
  }
  if (document.querySelector('[data-page="404"]')) problems.push("renders the not-found page")
  const width = document.documentElement.scrollWidth
  if (width > window.innerWidth + 1) problems.push(`page scrolls sideways: ${width}px wide in a ${window.innerWidth}px window`)
  return problems
}

/** Serializable DOM evidence, including location and computed solid-primary styling. */
export const collectPage = (): PageEvidence => {
  const visible = (el: Element): el is HTMLElement => {
    const style = getComputedStyle(el)
    return !el.closest("[data-mock], [hidden], [aria-hidden=true]") && el.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const name = (el: HTMLElement) => {
    const labelled = el.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)?.innerText ?? "").join(" ")
    return (el.getAttribute("aria-label") || labelled || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim()
  }
  const area = (el: Element) => el.closest("[role=dialog], aside, main, nav, header, form, section")?.getAttribute("class") ?? "page"
  const primary = (el: HTMLElement) => {
    const style = getComputedStyle(el)
    const background = style.backgroundColor
    const brand = document.createElement("span")
    brand.style.color = "var(--brand)"
    el.appendChild(brand)
    const brandColor = getComputedStyle(brand).color
    brand.remove()
    return el.getAttribute("data-variant") === "primary" || el.getAttribute("data-primary") === "true" ||
      /(?:^|[\s_-])primary(?:$|[\s_-])/.test(el.className) ||
      (background === brandColor && background !== "rgba(0, 0, 0, 0)" && background !== "transparent")
  }
  const buttons = [...document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], input[type="button"]')].filter(visible).map(el => ({
    name: name(el) || (el as HTMLInputElement).value || "",
    title: el.getAttribute("title") ?? "",
    action: !el.hasAttribute("data-inert"),
    primary: primary(el),
    disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
    tag: el.tagName.toLowerCase(), className: el.className, area: area(el)
  }))
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(visible).map(el => ({
    name: name(el), href: el.getAttribute("href") ?? "", title: el.getAttribute("title") ?? "", area: area(el), current: el.getAttribute("aria-current") ?? undefined
  }))
  // Solid links matter too: many legitimate primary navigation actions are <Link>s.
  const primaryLinks = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(visible).filter(primary).map(el => ({
    name: name(el), title: el.getAttribute("title") ?? "", action: false, primary: true,
    tag: "a", className: el.className, area: area(el)
  }))
  const primaries = [...buttons.filter(button => button.primary), ...primaryLinks]
  // innerText on the live body respects visibility; remove harness text explicitly.
  const harness = [...document.querySelectorAll<HTMLElement>("[data-mock]")].map(el => el.innerText).filter(Boolean)
  let text = document.body.innerText
  for (const value of harness) text = text.replace(value, "")
  // Partition by DOM membership, never by label: a view can have the same text
  // or control name as Ask. Do not mutate the page or the full observations.
  const frameSelector = '.repo-frame-global, .repo-frame-repo-header, .repo-frame-tabs, nav[aria-label="Repository"]'
  const buttonNodes = [...document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], input[type="button"]')].filter(visible)
  const linkNodes = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible)
  const primaryLinkNodes = linkNodes.filter(primary)
  const headingNodes = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")].filter(visible)
  const content = (root: HTMLElement | null, exclude = "") => {
    const includes = (el: Element) => Boolean(root?.contains(el)) && (!exclude || !el.closest(exclude))
    const read = (node: Node): string => {
      if (node.nodeType === 3) return node.textContent ?? ""
      if (!(node instanceof HTMLElement) || !visible(node) || exclude && node.matches(exclude)) return ""
      const value = [...node.childNodes].map(read).join("")
      return getComputedStyle(node).display === "inline" ? value : `\n${value}\n`
    }
    const ownButtons = buttons.filter((_, i) => includes(buttonNodes[i]!))
    const ownPrimaries = [...ownButtons.filter(button => button.primary), ...primaryLinks.filter((_, i) => includes(primaryLinkNodes[i]!))]
    return {
      text: root ? read(root).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "",
      headings: headingNodes.filter(includes).map(name), buttons: ownButtons,
      links: links.filter((_, i) => includes(linkNodes[i]!)), primary: ownPrimaries[0] ?? null, primaries: ownPrimaries
    }
  }
  const ask = document.querySelector<HTMLElement>("#repo-ask-panel")
  return {
    judgeParts: {
      content: content(document.body, `[data-mock], #repo-ask-panel, ${frameSelector}`),
      ask: { ...content(ask, "[data-mock]"), docked: Boolean(ask && visible(ask) && window.innerWidth >= 1440),
        suggestions: ask ? [...ask.querySelectorAll(".repo-frame-suggestion")].filter(visible).length : 0 },
      frame: [...document.querySelectorAll<HTMLElement>(frameSelector)].filter(visible).map(el => {
        const { x, y, width, height } = el.getBoundingClientRect()
        return { ...content(el, el.matches(".repo-frame-repo-header") ? '[data-mock], .repo-frame-tabs, nav[aria-label="Repository"]' : "[data-mock]"), selector: `.${el.classList[0]}`, bounds: { x, y, width, height } }
      })
    },
    layout: {
      viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
      tabs: [...document.querySelectorAll<HTMLElement>('.repo-frame-tabs a, .repo-frame-tabs button, [aria-label="Repository"] a, [aria-label="Repository navigation"] a')].filter(visible).map(name),
      regions: [".repo-frame-page", ".repo-frame-content", "#repo-ask-panel", ".repo-frame-inbox", ".repo-code-home-block", ".repo-code-home-file-table", ".repo-code-home-readme"].flatMap(selector =>
        [...document.querySelectorAll(selector)].map(el => {
          const rect = el.getBoundingClientRect()
          return { selector, visible: visible(el), x: rect.x, y: rect.y, width: rect.width, height: rect.height, position: getComputedStyle(el).position }
        }))
    },
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    headings: [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]")].filter(visible).map(name),
    buttons, links, primary: primaries[0] ?? null, primaries
  }
}

export const inspectView = async (view: ViewSpec, distName = process.env.MOCK_DIST ?? "dist-default-ui"): Promise<CaseOutput> => {
  const dist = resolve(mockRoot, distName)
  await access(join(dist, "index.html"))
  // Same package resolution as crawl.mjs; no new dependency or browser download.
  const { chromium } = createRequire(join(repoRoot, "apps/app/package.json"))("@playwright/test") as typeof import("../../../../../apps/app/node_modules/@playwright/test/index")
  const browser = await chromium.launch()
  const url = (route: string, theme: string) => `${pathToFileURL(join(dist, "index.html")).href}?still=1&theme=${theme}#/${route}`
  const observations: Observation[] = []
  // TS loaders with keepNames wrap named functions in __name(); define it in the page so serialized auditPage/collectPage run.
  const open = async (options?: Parameters<typeof browser.newPage>[0]) => {
    const page = await browser.newPage(options)
    await page.addInitScript({ content: "globalThis.__name = target => target" })
    return page
  }
  try {
    const probe = await open()
    let site: SitePayload
    try {
      await probe.goto(url("", "light"))
      await probe.waitForFunction(() => Boolean(window.__SITE__))
      site = await probe.evaluate(() => ({ site: window.__SITE__.site, screens: window.__SITE__.screens, routes: window.__SITE__.routes }))
    } finally { await probe.close() }
    if (!appliesToSite(view, site)) return {
      view: view.id, dist, states: {}, requiredStates: requiredStatesFor(view, site), routeProblems: [], ready: null, screens: [],
      notApplicable: `${view.view} is not declared by ${site.site ?? distName} for ${view.declaration?.repo}`
    }
    for (const screen of screensFor(view, site)) {
      for (const [width, height] of [[1440, 900], [1280, 900], [390, 844]]) {
        for (const theme of ["light", "dark"] as const) {
          const page: Page = await open({ viewport: { width: width!, height: height! }, colorScheme: theme })
          const errors: string[] = []
          page.on("pageerror", error => errors.push(`page error: ${error.message}`))
          page.on("console", message => { if (message.type() === "error") errors.push(`page error: ${message.text()}`) })
          try {
            await page.goto(url(screen.route, theme), { timeout: 30_000 })
            await page.waitForTimeout(screen.wait ?? 300)
            const resolved = await page.evaluate(route => window.__SITE__.resolve(route), screen.route)
            const problems = [...errors, ...await page.evaluate(auditPage)]
            if (!resolved) problems.push(`screen ${screen.id} has no resolving route`)
            const evidence = await page.evaluate(collectPage)
            observations.push({ id: screen.id, route: screen.route, width: width!, theme, resolved, problems: [...new Set(problems)], ...evidence })
          } catch (error) {
            // Keep a failed screen visible in the case instead of losing the rest
            // of its audit when navigation, page evaluation or rendering fails.
            observations.push({
              id: screen.id, route: screen.route, width: width!, theme, resolved: null,
              problems: [...new Set([...errors, `screen inspection failed: ${error instanceof Error ? error.message : "unknown failure"}`])],
              text: "", headings: [], buttons: [], links: [], primary: null, primaries: []
            })
          } finally { await page.close() }
        }
      }
    }
    const states = statesFor(view, site)
    return {
      view: view.id, dist, states, requiredStates: requiredStatesFor(view, site),
      routeProblems: routeProblemsFor(view, site, observations),
      ready: observations.find(item => states.ready?.includes(item.id) && item.width === 1440 && item.theme === "light") ?? null,
      screens: observations
    }
  } finally { await browser.close() }
}
