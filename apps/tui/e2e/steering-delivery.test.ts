/** The fixture must report delivery through the same event as the real host. */
import { expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui, workerTab } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const steeringLabel = /┃\s+steering\s*(?:\n|$)/

it(
  "removes the visible steering label at the real fixture drain, before completion, and replays delivery",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-steering-delivery-"))
    const previousSessions = process.env.SMITHERS_TUI_SESSION_DIR
    let tui: Tui | undefined
    try {
      // App repository discovery and completion would otherwise invoke Git.
      // Keep the fixture repository explicit and control only the file-list seam.
      const preload = join(root, "files.ts")
      writeFileSync(
        preload,
        `import { spyOn } from "bun:test"\n` +
          `import * as Files from ${JSON.stringify(join(app, "src/files.ts"))}\n` +
          `spyOn(Files, "lister").mockImplementation(() => () => [])\n`
      )
      tui = await Tui.start({
        cwd: root,
        cols: 110,
        rows: 42,
        command: `bun --preload ${quote(preload)} ${quote(join(app, "e2e/tabs-fixture.tsx"))}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_REPO: "fixture/steering",
          SMITHERS_TUI_FIXTURE_CWD: root,
          SMITHERS_TUI_SESSION_DIR: join(root, "sessions")
        }
      })
      await tui.until((screen) => screen.includes("Ask Smithers"), 15_000, "first draw")
      await tui.type("drive")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("implement/session ·"), 4_000, "worker card")
      await tui.press("\x1b[1;5C")
      await tui.press("\x1b[1;5C")
      await tui.until(workerTab("implement/session"), 4_000, "agent tab")
      // Steer just after a boundary passed, so the queued label is observable
      // for a whole fixture frame however slowly this machine types.
      await tui.until((screen) => screen.includes("read src/session.ts#1"), 8_000, "first boundary")
      await tui.type("deliver this steer")
      await tui.press(key.enter)
      const queued = await tui.until((screen) => steeringLabel.test(screen), 1_500, "queued label")
      expect(queued).toMatch(/┃\s+deliver this steer/)
      expect(queued).not.toMatch(/Frame \d: deliver this steer/)
      await tui.press(key.ctrlO)
      // Whichever boundary drains it: the label must go at that drain, not at completion.
      const delivered = await tui.until(
        (screen) => /Frame \d: deliver this steer/.test(screen),
        8_000,
        "frame using drained message"
      )
      expect(delivered).not.toMatch(steeringLabel)
      expect(delivered).not.toContain("Frame 4")
      expect(delivered.match(/┃\s+deliver this steer/g)).toHaveLength(1)

      const completed = await tui.until((screen) => screen.includes("Frame 4"), 12_000, "last frame")
      expect(completed).not.toMatch(steeringLabel)
      expect(completed.match(/┃\s+deliver this steer/g)).toHaveLength(1)
      // Read only this test's owned journal; completion is a persisted outcome.
      process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
      const chat = Session.load(Session.latest(root)!)
      const tab = Session.restore(chat).workspace.tabs.find((tab) => tab.id === "drive")!
      const records = Session.load(tab.file)
      expect(records.filter((record) => record.type === "outcome")).toMatchObject([
        { outcome: { _tag: "done" } }
      ])
      expect(records.filter((record) => record.type === "event" && record.event._tag === "steering-drained"))
        .toHaveLength(4)
      expect(
        Session.restore(records).transcript.items.flatMap((item) =>
          item.kind === "user" ? [{ text: item.text, queued: item.queued }] : []
        )
      ).toEqual([
        { text: "Implement the session refresh.", queued: undefined },
        { text: "deliver this steer", queued: false }
      ])
    } finally {
      await tui?.stop()
      if (previousSessions === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
      else process.env.SMITHERS_TUI_SESSION_DIR = previousSessions
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000
)
