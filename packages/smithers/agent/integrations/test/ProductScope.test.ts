import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import * as Integrations from "../src/index.ts"

const root = resolve(import.meta.dirname, "..")
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const providers = ["linear", "slack", "gmail", "googlecalendar", "x"]
// Telegram receives only: sending is @smthrs/notifications, and approvals, Mini App data, Markdown,
// chunking, issue sync and the Bot API client stay removed.
const removedTelegram = [
  "Actions",
  "Approval",
  "Chunk",
  "Config",
  "InitData",
  "Markdown",
  "TelegramClient",
  "IssueSync"
]

describe("integration product scope", () => {
  it("exports GitHub, Telegram receiving, and the shared primitives", () => {
    expect(Object.keys(Integrations).sort()).toEqual(["Core", "GitHub", "Telegram"])
    expect(Object.keys(Integrations.Telegram).sort()).toEqual(["Payload", "Source"])
    expect(Object.keys(Integrations.GitHub).sort()).toEqual([
      "Actions",
      "AppAuth",
      "Auth",
      "Calls",
      "Collaborators",
      "Commits",
      "Config",
      "Contents",
      "Delegation",
      "DelegationPolicy",
      "GitDatabase",
      "GitHubClient",
      "IssueChanges",
      "Issues",
      "Once",
      "Payload",
      "Proposals",
      "Proxy",
      "PublicRead",
      "Pulls",
      "RateLimit",
      "ReadCache",
      "Refs",
      "Repository",
      "Statuses",
      "Sync"
    ])
    expect(typeof Integrations.Core.Channel.make).toBe("function")
    expect(Integrations.Core.Migrations.set.migrations).toBeDefined()
  })

  it.each(providers)("removes %s implementations and executable exports", (provider) => {
    expect(existsSync(resolve(root, "src", provider))).toBe(false)
    expect(existsSync(resolve(root, "src", provider + ".ts"))).toBe(false)
    for (const map of [manifest.exports, manifest.publishConfig.exports]) {
      const entries = Object.entries(map).filter(([path]) =>
        path === `./${provider}` || path.startsWith(`./${provider}/`)
      )
      expect(entries.every(([, target]) => target === null)).toBe(true)
    }
  })

  it("keeps core/IssueSync removed: its backend routes are gone", () => {
    expect(existsSync(resolve(root, "src", "core", "IssueSync.ts"))).toBe(false)
    for (const map of [manifest.exports, manifest.publishConfig.exports]) {
      expect(map["./core/IssueSync"] ?? null).toBeNull()
    }
  })

  it.each(removedTelegram)("keeps telegram/%s removed", (module) => {
    expect(existsSync(resolve(root, "src", "telegram", module + ".ts"))).toBe(false)
    for (const map of [manifest.exports, manifest.publishConfig.exports]) {
      expect(map[`./telegram/${module}`] ?? null).toBeNull()
    }
  })
})
