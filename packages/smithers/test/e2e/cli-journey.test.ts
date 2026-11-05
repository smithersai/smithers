/** Current auth/session and repository-open contracts at the real executable boundary. */
import { NodeHost } from "@smthrs/platform-node"
import { RealCliDriver as Driver, TerminalRecording as Recording } from "@smthrs/testing"
import { Effect, FileSystem } from "effect"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const binary = resolve(import.meta.dirname, "../../src/bin.ts")
const artifactRoot = process.env.SMITHERS_TERMINAL_ARTIFACTS ??
  resolve(import.meta.dirname, "../../.cache/terminal-evidence")
const environment = {
  PATH: process.env.SMITHERS_TERMINAL_PATH ?? process.env.PATH ?? "",
  SMITHERS_API_ORIGIN: "https://smithers.sh"
}
const make = Driver.make({
  executable: process.execPath,
  args: ["--no-warnings", "--import", import.meta.resolve("vibelang/register"), binary],
  env: environment
})
const decode = (result: Driver.Result) => {
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout)
}

describe("real CLI terminal journeys", () => {
  it("proves signed-out session and credential refusal from fresh state", async () => {
    mkdirSync(artifactRoot, { recursive: true })
    const directory = join(mkdtempSync(join(artifactRoot, "auth-repo-")), "recording")
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const driver = yield* make
        const recording = yield* Recording.make({
          title: "CLI: session and repository",
          columns: 110,
          rows: 30,
          env: environment
        })
        const signedOut = yield* driver.run(["auth", "status", "--json"])
        expect(signedOut.code).toBe(1)
        expect(decode(signedOut)).toMatchObject({ logged_in: false, token_set: false })
        yield* recording.capture("Signed out", signedOut.stdout.trim())
        const token = yield* driver.run(["auth", "token", "--json"])
        expect(token.code).not.toBe(0)
        expect(token.stdout + token.stderr).toMatch(/login|logged|auth/i)
        yield* recording.capture("Credentials required", (token.stdout + token.stderr).trim())
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(driver.env.SMITHERS_AUTH_FILE)).toBe(false)
        const evidence = yield* recording.write(directory)
        expect(readFileSync(evidence.gif).subarray(0, 6).toString()).toBe("GIF89a")
        console.info(`Terminal evidence: ${evidence.manifest}`)
      })).pipe(Effect.provide(NodeHost.layer))
    )
  })
  it("opens a fresh jj checkout at the current repository page and dot alias", async () => {
    mkdirSync(artifactRoot, { recursive: true })
    const directory = join(mkdtempSync(join(artifactRoot, "repo-open-")), "recording")
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const driver = yield* make
        const recording = yield* Recording.make({ title: "CLI: repository page", env: environment })
        for (
          const args of [["git", "init"], [
            "git",
            "remote",
            "add",
            "origin",
            "https://github.com/terminal-e2e/project.git"
          ]]
        ) {
          const result = yield* Driver.execute({ executable: "jj", args, env: driver.env, cwd: driver.cwd })
          expect(result.code, result.stderr).toBe(0)
        }
        const opened = yield* driver.run(["open", "--json"])
        expect(opened.code).toBe(0)
        expect(decode(opened)).toMatchObject({
          repo: "terminal-e2e/project",
          opened: "web",
          url: "https://smithers.sh/terminal-e2e/project"
        })
        yield* recording.capture("Repository page", opened.stdout.trim())
        const alias = yield* driver.run([".", "--json"])
        expect(alias.code).toBe(0)
        expect(decode(alias)).toEqual(decode(opened))
        yield* recording.write(directory)
      })).pipe(Effect.provide(NodeHost.layer))
    )
  })

  it("keeps a second journey signed out and reports an unconfigured origin honestly", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const first = yield* make
        const second = yield* make
        expect(first.root).not.toBe(second.root)
        const result = yield* second.run(["auth", "status", "--json"])
        expect(result.code).toBe(1)
        expect(decode(result)).toMatchObject({ logged_in: false, token_set: false })
        const unconfigured = yield* Driver.make({
          executable: process.execPath,
          args: ["--no-warnings", "--import", import.meta.resolve("vibelang/register"), binary],
          env: { PATH: environment.PATH }
        })
        const missing = yield* unconfigured.run(["auth", "status", "--json"])
        expect(missing.code).toBe(1)
        expect(decode(missing)).toMatchObject({ code: "not_configured" })
      })).pipe(Effect.provide(NodeHost.layer))
    )
  })
})
