import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const workflow = readFileSync(new URL("../../.smithers/workflows/ci.tsx", import.meta.url), "utf8")
const shell = readFileSync(new URL("cloud.sh", import.meta.url), "utf8")
const github = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")
const dispatch = shell.slice(shell.indexOf('case "${1:-}" in'))
const gates = Array.from(dispatch.matchAll(/^  ([a-z][a-z0-9-]*)\)\n([\s\S]*?)    ;;/gm),
  ([, name, body]) => ({ name: name!, body: body! }))

describe("Smithers Cloud CI", () => {
  test("runs CI on main pushes and manual dispatch in parallel", () => {
    expect(workflow).toContain('<Workflow name="CI"')
    expect(workflow).toContain('triggers={[on.push({ branches: ["main"] }), on.manualDispatch({})]}')
    expect(workflow).toContain("<Parallel>")
    expect(workflow).toContain("</Parallel>")
  })

  test("every Task invokes exactly one implemented gate, with unique ids", () => {
    const tasks = Array.from(workflow.matchAll(/<Task\b([^>]*?)>([\s\S]*?)<\/Task>/g))
    expect(tasks.length).toBeGreaterThan(0)
    // An unparsed/self-closing Task must not disappear from the inventory.
    expect(tasks.length).toBe((workflow.match(/<Task\b/g) ?? []).length)
    const called: string[] = []
    const ids: string[] = []
    for (const [, props, body] of tasks) {
      const id = props!.match(/\bid="([^"]+)"/)?.[1]
      const call = body!.trim().match(/^\{`bash scripts\/ci\/cloud\.sh ([a-z][a-z0-9-]*)`\}$/)
      expect(id).toBeDefined()
      expect(props).toContain("secrets={[]}")
      expect(call).not.toBeNull()
      expect(call![1]).toBe(id)
      ids.push(id!)
      called.push(call![1]!)
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(gates.map(({ name }) => name)).size).toBe(gates.length)
    expect(called.sort()).toEqual(gates.map(({ name }) => name).sort())
  })

  test("each gate bootstraps JS and retains its exact GitHub CI command", () => {
    for (const { name, body } of gates) {
      expect(body.trimStart().startsWith("ensure_js\n")).toBe(true)
      if (name === "cloud-contract") {
        expect(body).toContain("bun test scripts/ci/cloud.test.ts")
      } else {
        const commands = Array.from(body.matchAll(/^    (pnpm exec .+)$/gm), ([, command]) => command!)
        expect(commands.length).toBe(1)
        expect(github).toContain(`run: "${commands[0]}"`)
      }
    }
    expect(shell).toContain('require("./package.json").packageManager')
    expect(shell).toContain('"$package_manager" --ignore-scripts')
    expect(shell).toContain("pnpm install --frozen-lockfile --ignore-scripts")
    expect(shell).toContain("set -euo pipefail")
    expect(shell.trimEnd().endsWith(`printf 'GATE-OK %s\\n' "$1"`)).toBe(true)
  })

  test("covers all non-publishing Linux commands except canonical-host wasm rebuild", () => {
    const excluded = new Set([
      "pnpm exec smthrs review '//...' --verbose",
      "pnpm exec smthrs test '//crates/flows-jj:wasmReproducibility' --verbose"
    ])
    const commands = Array.from(github.matchAll(/run: "(pnpm exec [^"]+)"/g), ([, command]) => command!)
    for (const command of new Set(commands)) {
      if (!excluded.has(command)) expect(dispatch).toContain(command)
    }
  })

  test("bash accepts the runner syntax", () => {
    const result = spawnSync("bash", ["-n", "scripts/ci/cloud.sh"], { cwd: root, encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  test("missing and unknown gates fail before installing tools or reporting success", () => {
    for (const args of [[], ["not-a-gate"]]) {
      const result = spawnSync("bash", ["scripts/ci/cloud.sh", ...args], { cwd: root, encoding: "utf8" })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unknown Cloud CI gate:")
      expect(result.stdout).toBe("")
    }
  })
})
