import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as Presence from "../src/internal/ReviewFilePresence.ts"
import * as SafeFs from "../src/SafeFs.ts"

it("distinguishes required context disappearance from an allowed changed-file deletion", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-file-presence-")))
  try {
    const path = Path.join(root, "context.txt")
    await Fs.writeFile(path, "required context")
    const present = await SafeFs.readText(path, { root, symlinks: "reject", limit: 1024, what: "review context" })
    expect(Presence.contents("context.txt", present, "fail")).toBe("required context")
    expect(Presence.contents("context.txt", present, "skip")).toBe("required context")
    await Fs.rm(path)
    const missing = await SafeFs.readText(path, { root, symlinks: "reject", limit: 1024, what: "review context" })
    expect(missing).toBeUndefined()
    expect(Presence.contents("context.txt", missing, "skip")).toBeUndefined()
    expect(() => Presence.contents("context.txt", missing, "fail")).toThrow(
      "LLM review file disappeared after discovery: context.txt"
    )
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
