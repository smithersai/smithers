/** #4385: a real terminal consumes the existing CLI login independently of factory access. */
import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

it("shows unknown then the authenticated person in an app-only directory, keeping the composer usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-identity-"))
  const seen: string[] = []
  let finish!: () => void
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push(new URL(request.url).pathname)
      expect(request.headers.get("authorization")).toBe("token tok_terminal_identity_sentinel")
      await ready
      return Response.json({ login: "terminal-person", email: "person@example.test" })
    }
  })
  let tui: Tui | undefined
  try {
    mkdirSync(join(root, ".smithers"))
    writeFileSync(
      join(root, ".smithers/home.json"),
      JSON.stringify({
        blocks: [{ type: "app", title: "Identity app", flow: "identity", picture: "identity" }]
      })
    )
    tui = await Tui.start({
      cwd: root,
      cols: 110,
      rows: 30,
      command: `bun ${resolve(import.meta.dir, "tabs-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        XDG_CONFIG_HOME: root,
        SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
        SMITHERS_TOKEN: "tok_terminal_identity_sentinel"
      }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("/smithers")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Connection unknown") && screen.includes("Identity app"))
    await tui.press(key.ctrlS)
    await tui.type("identity draft")
    await tui.until((screen) => screen.includes("identity draft"))
    finish()
    await tui.until((screen) => screen.includes("Connected · @terminal-person"))
    const screen = tui.screen()
    expect(screen).toContain("identity draft")
    expect(screen).not.toContain("tok_terminal_identity_sentinel")
    expect(seen).toEqual(["/api/user"])
  } finally {
    finish()
    await tui?.stop()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
