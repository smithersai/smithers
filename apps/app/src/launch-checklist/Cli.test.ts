/*
 * The CLI contract the runbook documents. `pnpm run checklist -- --target
 * <origin>` is the command the launch runbook prints, so the flags it forwards
 * are covered here rather than only in prose.
 */
import { describe, expect, test } from "bun:test"
import { BROWSER_CANDIDATES, browserArgv, findBrowser, newTargetUrl } from "./BrowserLaunch.ts"
import { HELP, parseArgs, reportDir } from "./Cli.ts"

describe("parseArgs", () => {
  test("reads the target in both spellings", () => {
    expect(parseArgs(["--target", "https://canary.smithers.sh"]).target).toBe("https://canary.smithers.sh")
    expect(parseArgs(["--target=https://canary.smithers.sh"]).target).toBe("https://canary.smithers.sh")
    expect(parseArgs(["-t", "http://127.0.0.1:8787"]).target).toBe("http://127.0.0.1:8787")
  })

  test("dry run needs no target and asks for no browser", () => {
    const args = parseArgs(["--dry-run"])
    expect(args.dryRun).toBe(true)
    expect(args.target).toBeUndefined()
  })

  test("carries the browser flags for the headless page driver", () => {
    expect(parseArgs(["--browser", "/opt/chrome"]).browserPath).toBe("/opt/chrome")
    expect(parseArgs(["--browser=/opt/chrome"]).browserPath).toBe("/opt/chrome")
    expect(parseArgs(["--no-browser"]).noBrowser).toBe(true)
  })

  test("an unknown flag is ignored rather than crashing a post-deploy re-run", () => {
    expect(parseArgs(["--nonsense", "--dry-run"]).dryRun).toBe(true)
  })

  test("the help text names the command as run from the repo root", () => {
    expect(HELP).toContain("pnpm run checklist -- --target <origin>")
  })
})

describe("reportDir", () => {
  test("defaults under apps/reports with the mode in the folder name", () => {
    expect(reportDir(parseArgs(["--dry-run"]), "2026-08-16T12:00:00.000Z")).toBe(
      "../reports/launch-checklist/2026-08-16T12-00-00Z-dry-run"
    )
    expect(reportDir(parseArgs(["-t", "x"]), "2026-08-16T12:00:00.000Z")).toBe(
      "../reports/launch-checklist/2026-08-16T12-00-00Z-run"
    )
  })

  test("--out wins", () => {
    expect(reportDir(parseArgs(["--out", "/tmp/report"]), "2026-08-16T12:00:00.000Z")).toBe("/tmp/report")
  })
})

describe("browser discovery", () => {
  const never = (): boolean => false

  test("an explicit --browser wins even when the path does not exist, so a typo fails loudly", () => {
    expect(findBrowser({ explicit: "/opt/typo", env: {}, exists: never })).toBe("/opt/typo")
  })

  test("$CHECKLIST_BROWSER comes next, then the known install locations", () => {
    expect(findBrowser({ env: { CHECKLIST_BROWSER: "/opt/chrome" }, exists: never })).toBe("/opt/chrome")
    const second = BROWSER_CANDIDATES[1]
    expect(findBrowser({ env: {}, exists: (path) => path === second })).toBe(second)
  })

  test("no browser at all is undefined, which the runner turns into not-testable-yet", () => {
    expect(findBrowser({ env: {}, exists: never })).toBeUndefined()
  })

  test("the launch argv is headless and isolated to its own profile", () => {
    const argv = browserArgv("/opt/chrome", 9444, "/tmp/profile")
    expect(argv).toContain("--headless=new")
    expect(argv).toContain("--remote-debugging-port=9444")
    expect(argv).toContain("--user-data-dir=/tmp/profile")
  })

  test("the DevTools target url encodes the page it opens", () => {
    expect(newTargetUrl(9444, "https://canary.smithers.sh")).toBe(
      "http://127.0.0.1:9444/json/new?https%3A%2F%2Fcanary.smithers.sh"
    )
  })
})
