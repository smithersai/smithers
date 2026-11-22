import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Inventory from "../src/contract/Inventory.ts"
import { reasonRows, reasons, reasonsSentence } from "../src/contract/Reasons.ts"
import { notSelected, notTargets } from "../src/native/index.ts"

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")

const sources = (readdirSync(join(packageDir, "src"), { recursive: true, encoding: "utf8" }) as Array<string>)
  .filter((path) => /\.(ts|vibe)$/.test(path) && !path.endsWith(".d.vibe.ts"))
  .map((path) => readFileSync(join(packageDir, "src", path), "utf8"))

/** The features the program records by a literal word, at each place it records one. */
const recorded = [
  /\bnote\([\w.]+,\s*"([a-z-]+)"/g,
  /\bnote\(\s*[\w.]+,\s*\n?\s*"([a-z-]+)"/g,
  /fileProblem\([\w.]+,\s*"([a-z-]+)"/g,
  /\bblock\(\w+,\s*"([a-z-]+)"/g,
  /\bfail\(scope,\s*"([a-z-]+)"/g,
  /unknownVariable\([^,]+,\s*"([a-z-]+)"/g,
  /problems\.push\(\["([a-z-]+)"/g,
  /problems\.push\(\{ feature: "([a-z-]+)"/g
].flatMap((pattern) => sources.flatMap((text) => [...text.matchAll(pattern)].map((match) => match[1] as string)))

/** What the readers record from a table or a computed word, and the constants of the contract. */
const named = [
  "services",
  "container",
  "environment",
  "continue-on-error",
  "default-rule",
  "ignored-failure",
  "second-expansion",
  "vpath",
  "load",
  Inventory.otherSystem,
  Inventory.selfHosted,
  Inventory.missingTool,
  Inventory.changesMachine,
  Inventory.docker,
  Inventory.leftRunning,
  Inventory.noCommand,
  Inventory.noTarget,
  Inventory.longRunning,
  Inventory.hostAction,
  Inventory.triggerFilter,
  Inventory.conditionFalse,
  Inventory.unkeptResult,
  Inventory.releaseTrigger,
  Inventory.writePermission,
  Inventory.secret,
  Inventory.needsLeftOut,
  Inventory.uncommittedChanges,
  Inventory.smithersBuild,
  notSelected,
  notTargets
]

describe("the reasons a job is not replayed", () => {
  it("have a sentence for every feature the program records", () => {
    expect(recorded.length).toBeGreaterThan(40)
    const missing = [...new Set([...recorded, ...named])].filter((feature) => !Object.hasOwn(reasons, feature))
    expect(missing, "add each of these to src/contract/Reasons.ts and to the table in docs/reference/cli.md").toEqual(
      []
    )
  })

  it("are the table in the command reference, word for word", () => {
    const page = readFileSync(join(packageDir, "docs/reference/cli.md"), "utf8")
    const section = page.slice(page.indexOf("## Why a job is not replayed"), page.indexOf("## Environment"))
    const rows = section.split("\n").filter((line) => line.startsWith("| `")).map((line) => {
      const [name, meaning] = line.slice(1, -1).split("|").map((cell) => cell.trim())
      return [(name as string).replaceAll("`", ""), meaning]
    })
    expect(rows).toEqual(reasonRows().map(([feature, meaning]) => [feature, meaning]))
  })

  it("use no word only this project uses", () => {
    for (const [, meaning] of reasonRows()) expect(meaning).not.toMatch(/\b(inventory|target|scorer|contract)\b/i)
  })
})

describe("reasonsSentence", () => {
  const sentence = (feature: string, ...details: ReadonlyArray<string>) =>
    reasonsSentence(details.map((detail) => ({ feature, detail })))

  it("names the action a job uses", () => {
    expect(sentence("uses", ".github/workflows/ci.yml: acme/deploy@v2 has no command to run")).toBe(
      "uses the action acme/deploy@v2, which Smithers CI does not run"
    )
    expect(sentence("uses", "ci.yml: step 3: ./local/action needs input")).toBe(
      "uses the action ./local/action, which Smithers CI does not run"
    )
    expect(sentence("uses", "ci.yml: nothing to name")).toBe(
      "uses the action with no command, which Smithers CI does not run"
    )
  })

  it("says where to run a job for another system", () => {
    expect(sentence("other-system", "ci.yml: t runs on macOS; this machine is Linux")).toBe(
      "runs only on macOS; run smithers-ci on a Mac"
    )
    expect(sentence("other-system", "t runs on darwin; this machine is linux")).toBe(
      "runs only on macOS; run smithers-ci on a Mac"
    )
    expect(sentence("other-system", "t runs on linux; this machine is darwin")).toBe(
      "runs only on Linux; run smithers-ci on Linux"
    )
    expect(sentence("other-system", "t runs on win32; this machine is linux")).toBe(
      "runs only on Windows; smithers-ci runs on Linux and macOS"
    )
    expect(sentence("other-system", "no system here")).toBe(
      "runs only on another operating system; run smithers-ci on that system"
    )
  })

  it("lists what to install, once each", () => {
    expect(sentence("missing-tool", "go 1.23", "ruby 3.4.6", "go 1.23")).toBe(
      "needs go 1.23, ruby 3.4.6, which this machine does not have; install it and run smithers-ci again"
    )
  })

  it("names the job needed and the secret received", () => {
    expect(sentence("needs", "b needs a, which is not replayed")).toBe("needs a, which is not replayed")
    expect(sentence("secret", "ci.yml:t:1 receives NPM_TOKEN, GH_TOKEN")).toBe(
      "receives the secret NPM_TOKEN, GH_TOKEN, which a replay never has"
    )
  })

  it("joins the reasons of a job, each feature once, in the order found", () => {
    expect(reasonsSentence([
      { feature: "condition", detail: "a" },
      { feature: "shell", detail: "b" },
      { feature: "condition", detail: "c" }
    ])).toBe("runs only when a condition holds that a replay cannot check; runs in a shell other than bash or sh")
  })

  it("still says something for a feature it does not know", () => {
    expect(sentence("brand-new", "x")).toBe("uses something Smithers CI cannot run (brand-new)")
  })
})
