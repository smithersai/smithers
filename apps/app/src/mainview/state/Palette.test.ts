import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { scopedControllers } from "./ControllerTestScope"
import { DEFAULT_PALETTE, PALETTES } from "./AppState"
import { createAppStore } from "./AppStore"
import { memoryStorage, unavailableAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The color-theme axis (/theme), orthogonal to light/dark (/dark-mode). Three
 * halves are pinned here: the store half (the palette is session state with
 * the same persistence every other session field has), the DOM half (the
 * store stamps data-palette on the root element the way it stamps data-theme),
 * and the CSS half (every registered key actually HAS both variants in
 * tokens.css — a key that round-trips into the attribute but matches no block
 * would silently render the default).
 */

GlobalRegistrator.register()

/*
 * bun test shares one process across test files, so the DOM globals registered
 * above would otherwise leak into every file that runs after this one and
 * silently flip `typeof window`/`typeof document` branches (AppStore's theme
 * detection reads both). Registration is confined to this file's run.
 */
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tokens = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8")
/** Comments carry braces and selector-looking text, so the block scan reads the code alone. */
const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "")

/** The semantic values a palette owns: everything else in tokens.css derives from these. */
const SEMANTIC_TOKENS = [
  "--bg",
  "--text",
  "--text-muted",
  "--text-faint",
  "--text-placeholder",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--surface-glass",
  "--surface-glass-strong",
  "--border",
  "--border-strong",
  "--border-solid",
  "--hover",
  "--hover-subtle",
  "--inverse-bg",
  "--inverse-text",
  "--brand",
  "--success",
  "--warning",
  "--danger",
  "--info",
  "--code-bg",
  "--code-text",
  "--inline-code-bg",
  "--shadow-rgb"
] as const

/** The declarations inside the first block whose selector matches exactly. */
const blockFor = (selector: string): string | undefined => {
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").trim() === selector) return match[2] ?? ""
  }
  return undefined
}

const declares = (body: string, token: string): boolean => new RegExp(`(^|\\s)${token}\\s*:`, "m").test(body)

describe("the color-theme axis in the store and the DOM", () => {
  test("a fresh session boots on the default palette, stamped beside data-theme", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    expect(store.session().palette).toBe(DEFAULT_PALETTE)
    expect(document.documentElement.dataset.palette).toBe(DEFAULT_PALETTE)
    expect(document.documentElement.dataset.theme).toBe(store.session().theme)
  })

  test("every registered palette round-trips through /theme into the attribute", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, unavailableAgent)
    for (const palette of PALETTES) {
      expect((await controller.commands.run("appearance.theme", palette)).status).toBe("executed")
      expect(store.session().palette).toBe(palette)
      expect(document.documentElement.dataset.palette).toBe(palette)
    }
  })

  test("the chosen palette persists across store instances and is re-stamped on boot", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    const transaction = first.dispatch({ type: "palette.changed", actor: "user", palette: "gruvbox" })
    await transaction.isPersisted.promise
    expect(first.session().palette).toBe("gruvbox")

    document.documentElement.removeAttribute("data-palette")
    const second = await createAppStore({ kind: "localStorage", storage })
    expect(second.session().palette).toBe("gruvbox")
    expect(document.documentElement.dataset.palette).toBe("gruvbox")
  })

  test("the two axes are independent: the light/dark toggle leaves the palette alone", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, unavailableAgent)
    await controller.commands.run("appearance.theme", "catppuccin")
    const before = store.session().theme
    await controller.commands.run("appearance.dark-mode")
    expect(store.session().theme).not.toBe(before)
    expect(store.session().palette).toBe("catppuccin")
    expect(document.documentElement.dataset.palette).toBe("catppuccin")
    expect(document.documentElement.dataset.theme).toBe(store.session().theme)
  })
})

describe("tokens.css carries a full pair of variants for every palette", () => {
  test("the default palette IS :root, in both variants", () => {
    const light = blockFor(":root")
    const dark = blockFor(":root[data-theme=\"dark\"]")
    expect(light).toBeDefined()
    expect(dark).toBeDefined()
    const missing = SEMANTIC_TOKENS.flatMap((token) => [
      ...(declares(light ?? "", token) ? [] : [`:root ${token}`]),
      ...(declares(dark ?? "", token) ? [] : [`:root[data-theme="dark"] ${token}`])
    ])
    expect(missing).toEqual([])
    // night-owl is the default, so it never needs a data-palette block.
    expect(tokens).not.toContain("[data-palette=\"night-owl\"]")
  })

  test("every non-default palette declares the full semantic set in BOTH variants", () => {
    /*
     * Both blocks must be complete: `:root[data-palette="K"]` and
     * `:root[data-theme="dark"]` have equal specificity, so a value missing
     * from a palette's dark block would leak its light value into dark.
     */
    const missing: Array<string> = []
    for (const palette of PALETTES) {
      if (palette === DEFAULT_PALETTE) continue
      const light = blockFor(`:root[data-palette="${palette}"]`)
      const dark = blockFor(`:root[data-palette="${palette}"][data-theme="dark"]`)
      if (light === undefined) missing.push(`${palette}: no light block`)
      if (dark === undefined) missing.push(`${palette}: no dark block`)
      for (const token of SEMANTIC_TOKENS) {
        if (light !== undefined && !declares(light, token)) missing.push(`${palette} light ${token}`)
        if (dark !== undefined && !declares(dark, token)) missing.push(`${palette} dark ${token}`)
      }
    }
    expect(missing).toEqual([])
  })

  test("the bridge and geometry sections stay single and shared", () => {
    // Palette blocks override semantic values only; the bridge derives from
    // them, so a palette that redeclared a bridge token would fork it.
    const bridgeOnly = ["--brand-soft", "--sp-4", "--ctl-h", "--panel", "--font-sans"]
    const forked: Array<string> = []
    for (const palette of PALETTES) {
      if (palette === DEFAULT_PALETTE) continue
      const blocks = [
        blockFor(`:root[data-palette="${palette}"]`) ?? "",
        blockFor(`:root[data-palette="${palette}"][data-theme="dark"]`) ?? ""
      ]
      for (const body of blocks) {
        for (const token of bridgeOnly) {
          if (declares(body, token)) forked.push(`${palette} redeclares ${token}`)
        }
      }
    }
    expect(forked).toEqual([])
    expect(tokens.split("--brand-soft:").length - 1).toBe(1)
    expect(tokens.split("--sp-4:").length - 1).toBe(1)
  })
})
