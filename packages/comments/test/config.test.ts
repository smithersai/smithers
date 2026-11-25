import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { Config } from "../src/index.ts"

describe("Config", () => {
  it.effect("returns documented defaults when no config file exists", () =>
    Effect.gen(function*() {
      const dir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-cfg-")))
      try {
        const loaded = yield* Config.loadConfig(dir)
        expect(loaded.exists).toBe(false)
        expect(loaded.config.mode).toBe("inline")
        expect(loaded.config.commentsDir).toBe(".comments")
        expect(loaded.config.preservePragmas).toBe(true)
        expect(loaded.config.strictExternal).toBe(true)
        expect(loaded.config.agent).toBe("heuristic")
      } finally {
        yield* Effect.promise(() => Fs.rm(dir, { recursive: true, force: true }))
      }
    }))

  it.effect("parses valid external config with custom commentsDir", () =>
    Effect.gen(function*() {
      const cfg = yield* Config.parseConfig(
        JSON.stringify({
          version: 1,
          mode: "external",
          commentsDir: "docs/comments",
          extraPragmaPatterns: ["^CUSTOM:"]
        })
      )
      expect(cfg.mode).toBe("external")
      expect(cfg.commentsDir).toBe("docs/comments")
      expect(cfg.extraPragmaPatterns).toEqual(["^CUSTOM:"])
      expect(cfg.preservePragmas).toBe(true)
    }))

  it.effect("rejects invalid JSON, path traversal commentsDir, bad mode, and invalid regex", () =>
    Effect.gen(function*() {
      const badPayloads = [
        "{not json",
        JSON.stringify({ version: 2 }),
        JSON.stringify({ mode: "sideways" }),
        JSON.stringify({ commentsDir: "../escape" }),
        JSON.stringify({ commentsDir: "/abs/path" }),
        JSON.stringify({ extraPragmaPatterns: ["[unclosed"] })
      ]
      for (const payload of badPayloads) {
        const exit = yield* Effect.exit(Config.parseConfig(payload))
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }))
})
