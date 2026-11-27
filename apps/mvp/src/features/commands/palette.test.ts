import { describe, expect, test } from "vitest"
import { blobPathOf, matchScore, paletteItemsOf, resolveRepoTarget } from "./palette"

describe("resolveRepoTarget", () => {
  test("passes non-templated paths through unchanged", () => {
    expect(resolveRepoTarget("/app/queue", undefined, undefined)).toBe("/app/queue")
  })

  test("resolves /{repo}/ against active repo, falling back to fallbackRepo, else undefined", () => {
    const active = { owner: "acme", name: "widgets" }
    const fallback = { owner: "smithersai", name: "smithers" }
    expect(resolveRepoTarget("/{repo}/-/factory", active, fallback)).toBe("/acme/widgets/-/factory")
    expect(resolveRepoTarget("/{repo}/-/factory/agents", undefined, fallback)).toBe("/smithersai/smithers/-/factory/agents")
    expect(resolveRepoTarget("/{repo}/-/factory", undefined, undefined)).toBeUndefined()
    expect(resolveRepoTarget("/{repo}/-/factory", { owner: "", name: "" }, undefined)).toBeUndefined()
  })
})

describe("matchScore and blobPathOf", () => {
  test("scores exact, basename, prefix, substring, and non-matching strings", () => {
    expect(matchScore("", "anything")).toBe(0)
    expect(matchScore("readme.md", "README.md")).toBe(0)
    expect(matchScore("main.ts", "src/main.ts")).toBe(1)
    expect(matchScore("main", "src/main.ts")).toBe(2)
    expect(matchScore("src/", "a/src/main.ts")).toBeGreaterThan(2)
    expect(matchScore("zzz", "src/main.ts")).toBeUndefined()
  })

  test("builds encoded blob URLs defaulting revision to HEAD", () => {
    expect(blobPathOf({ owner: "acme", name: "widgets" }, "/src/my file.ts")).toBe("/acme/widgets/blob/HEAD/src/my%20file.ts")
    expect(blobPathOf({ owner: "acme", name: "widgets", revision: "feat/x" }, "a/b.ts")).toBe("/acme/widgets/blob/feat%2Fx/a/b.ts")
  })
})

describe("paletteItemsOf", () => {
  const commands = [
    { id: "factory/open", flow: "app/navigate", title: "Factory", minimum: "anyone" as const, palette: true, args: { to: "/{repo}/-/factory" } },
    { id: "factory/decide", flow: "app/navigate", title: "Factory decisions", minimum: "maintainer" as const, palette: true, args: { to: "/{repo}/-/factory/for-you" } },
    { id: "bugs/report", flow: "app/navigate", title: "Report a bug", minimum: "anyone" as const, palette: true, args: { to: "/app/bugs/new" } },
    { id: "hidden/cmd", flow: "app/navigate", title: "Hidden", minimum: "anyone" as const, palette: false, args: { to: "/app" } },
    { id: "plain/action", flow: "app/theme/set", title: "Toggle theme", minimum: "anyone" as const, palette: true },
  ]

  test("filters core and plugin commands by viewer role and skips unresolved /{repo}/ commands", () => {
    const visitor = paletteItemsOf("", { viewer: { signedIn: false, role: null }, commands })
    expect(visitor.map((item) => item.id)).toContain("go:chat")
    expect(visitor.map((item) => item.id)).toContain("cmd:bugs/report")
    expect(visitor.map((item) => item.id)).toContain("cmd:plain/action")
    expect(visitor.map((item) => item.id)).not.toContain("go:flows")
    expect(visitor.map((item) => item.id)).not.toContain("cmd:factory/open")
    expect(visitor.map((item) => item.id)).not.toContain("cmd:factory/decide")
    expect(visitor.map((item) => item.id)).not.toContain("cmd:hidden/cmd")
  })

  test("includes repository sections, resolved plugin commands, cached Go-to-File matches, and direct file path jump", () => {
    const activeRepo = { owner: "acme", name: "widgets", revision: "main" }
    const paths = ["README.md", "src/main.ts", "src/app/router.tsx"]
    const maintainer = { signedIn: true, role: "maintainer" as const }

    const all = paletteItemsOf("", { viewer: maintainer, commands, activeRepo, paths })
    expect(all.find((item) => item.id === "cmd:factory/open")?.args).toEqual({ to: "/acme/widgets/-/factory" })
    expect(all.find((item) => item.id === "cmd:factory/decide")?.args).toEqual({ to: "/acme/widgets/-/factory/for-you" })
    expect(all.some((item) => item.id === "repo:stack")).toBe(true)
    expect(all.some((item) => item.id === "file:src/main.ts")).toBe(true)

    const fileQuery = paletteItemsOf("router.tsx", { viewer: maintainer, commands, activeRepo, paths })
    expect(fileQuery[0]).toMatchObject({ id: "file:src/app/router.tsx", args: { to: "/acme/widgets/blob/main/src/app/router.tsx" } })

    const directQuery = paletteItemsOf("docs/guide.md", { viewer: maintainer, commands, activeRepo, paths })
    expect(directQuery).toContainEqual(expect.objectContaining({
      id: "file-direct:docs/guide.md",
      args: { to: "/acme/widgets/blob/main/docs/guide.md" },
    }))

    // Active repo without cached tree paths still lists repo sections and direct path jumps
    const noTree = paletteItemsOf("README.md", { viewer: maintainer, commands, activeRepo })
    expect(noTree).toContainEqual(expect.objectContaining({ id: "file-direct:README.md" }))
  })
})
