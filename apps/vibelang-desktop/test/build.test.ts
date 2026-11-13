// Build configuration has no Effect code; exercise its real process environment and arguments.
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const config = pathToFileURL(resolve("electrobun.config.ts")).href
const load = "const { default: config } = await import(process.argv[1]); console.log(JSON.stringify(config.build.linux.chromiumFlags))"
const build = (args: string[], test?: string) => {
  const env = { ...process.env }
  delete env.VIBELANG_DESKTOP_TEST
  if (test !== undefined) env.VIBELANG_DESKTOP_TEST = test
  return spawnSync(process.execPath, ["--input-type=module", "-e", load, "--", config, ...args], { env, encoding: "utf8" })
}

describe("desktop debugging admission", () => {
  it.each([[], ["build"], ["build", "--env=dev"], ["build", "--env=canary"], ["build", "--env=stable"]])("leaves ordinary builds without a debugging port: %j", (...args) => {
    const result = build(args)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })
  it.each([undefined, "0", "true"])("permits a stable build without test mode: %s", (test) => {
    const result = build(["build", "--env=stable"], test)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })
  it.each([[], ["build"], ["build", "--env=dev"], ["build", "--env=canary"]])("keeps native test builds debuggable: %j", (...args) => {
    const result = build(args, "1")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)["remote-debugging-port"]).toBe("14509")
  })
  it("refuses stable artifacts when test mode is inherited", () => {
    const result = build(["build", "--env=stable"], "1")
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("VIBELANG_DESKTOP_TEST must be unset for stable builds")
    expect(result.stdout).toBe("")
  })
})
