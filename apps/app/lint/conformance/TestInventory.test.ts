import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import type { PlaywrightTestConfig } from "@playwright/test"
import playwright from "../../playwright.config"
import playwrightSite from "../../playwright.site.config"
import playwrightReal from "../../playwright.real.config"
import playwrightGraph from "../../playwright.graph.config"

const app = fileURLToPath(new URL("../../", import.meta.url))
const root = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(app, path), "utf8")
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/
const files = execFileSync("rg", ["--files", "apps/app"], {
  cwd: root, encoding: "utf8"
}).trim().split("\n").map((path) => path.slice("apps/app/".length)).filter((path) => testFile.test(path))

// Evaluate the real declaration in Node, outside the application's type graph.
const inspectTarget = (body: string) => JSON.parse(execFileSync("node", ["--input-type=module", "-e", `
  import { Package } from "./PACKAGE.ts"
  import { metadata } from "@smthrs/targets/Target"
  import * as Input from "@smthrs/targets/Input"
  const unit = metadata(Package.unitTests)
  ${body}
`], { cwd: app, encoding: "utf8", timeout: 120_000 }))

const bunPaths = (command: string | undefined): string[] => command?.startsWith("bun test ")
  ? command.slice("bun test ".length).split(/\s+/) : []
const selected = (path: string, paths: readonly string[]) => paths.some((entry) => path === entry || path.startsWith(`${entry}/`))

// Read only executable Bun argv arrays, not mentions in comments or conformance inputs.
const packagedTests = (): string[] => {
  const source = ts.createSourceFile("run.ts", read("e2e/packaged/run.ts"), ts.ScriptTarget.Latest, true)
  const paths: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements[0]?.getText(source) === "process.execPath" &&
      node.elements[1] && ts.isStringLiteral(node.elements[1]) && node.elements[1].text === "test") {
      paths.push(...node.elements.filter(ts.isStringLiteral).map((item) => item.text).filter((item) => testFile.test(item)))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return paths
}

const packaged = packagedTests()
// The real lane is a directly executable script; `test:e2e:real` only names it.
// Admit only its actual Playwright invocation, never a comment/config mention.
const invokesRealPlaywright = (source: string): boolean => {
  const parsed = ts.createSourceFile("run-real-e2e.ts", source, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "run" &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "pnpm" &&
      node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])) {
      const args = node.arguments[1].elements
      found ||= ["exec", "playwright", "test", "--config", "playwright.real.config.ts"].every((value, index) =>
        args[index] !== undefined && ts.isStringLiteral(args[index]) && args[index].text === value)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}
const realRunner = invokesRealPlaywright(read("scripts/run-real-e2e.ts"))

/*
 * The flow-graph tier is a step of the PR browser runner rather than a
 * package.json alias, and the flow builder's build-time flag makes it two
 * steps. Admit only an actual argv array, never a comment or a config mention,
 * for the reason the real lane gives above.
 */
const invokesGraphPlaywright = (source: string): boolean => {
  const parsed = ts.createSourceFile("run-pr-e2e.mjs", source, ts.ScriptTarget.Latest, true)
  const wanted = ["exec", "playwright", "test", "--config", "playwright.graph.config.ts"]
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const args = node.elements
      found ||= wanted.every((value, index) =>
        args[index] !== undefined && ts.isStringLiteral(args[index]) && args[index].text === value)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}
const graphRunner = invokesGraphPlaywright(read("scripts/run-pr-e2e.mjs"))
const matches = (path: string, patterns: string | RegExp | readonly (string | RegExp)[]): boolean =>
  (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) =>
    typeof pattern === "string" ? new Bun.Glob(pattern).match(path) : pattern.test(path))
const playwrightOwns = (path: string, config: PlaywrightTestConfig): boolean =>
  (config.projects ?? [{}]).some(project =>
    selected(path, [project.testDir ?? config.testDir!]) &&
    matches(path, project.testMatch ?? config.testMatch ?? /\.(spec|test)\.[cm]?[jt]sx?$/) &&
    !matches(path, project.testIgnore ?? config.testIgnore ?? []))

const owners = (path: string): string[] => {
  const result: string[] = []
  if (selected(path, bunPaths(scripts.test))) result.push("unit")
  if (selected(path, bunPaths(scripts["lint:conformance"]))) result.push("conformance lint")
  if (selected(path, bunPaths(scripts["test:e2e:auth"]))) result.push("browser OAuth")
  if (selected(path, bunPaths(scripts["test:e2e:probes"]))) result.push("probe helpers")
  if (scripts["test:e2e"] === "playwright test" && playwrightOwns(path, playwright)) result.push("Playwright")
  if (scripts["test:e2e:site"] === "playwright test --config playwright.site.config.ts" && playwrightOwns(path, playwrightSite)) result.push("Playwright site")
  if (scripts["test:e2e:packaged"] === "bun e2e/packaged/run.ts" && packaged.includes(path)) result.push("packaged native")
  if (realRunner && playwrightOwns(path, playwrightReal)) result.push("Playwright real")
  if (graphRunner && playwrightOwns(path, playwrightGraph)) result.push("Playwright graph")
  return result
}

test("every app test belongs to an executable runner", () => {
  expect(files.length).toBeGreaterThan(100)
  expect(files.filter((path) => owners(path).length === 0)).toEqual([])
  expect(owners("e2e/native/CloudAuthFragment.test.ts")).toEqual(["browser OAuth"])
  // A Bun test that launches Chromium belongs to the tier that installs it,
  // never to the hermetic unit gate.
  expect(owners("e2e/probes/support.test.mjs")).toEqual(["probe helpers"])
  expect(owners("scripts/canary-restoration.test.ts")).toContain("unit")
  expect(owners("scripts/headless-page.test.ts")).toContain("unit")
  // The literal pin is a lint target with its own runner, never the unit gate.
  expect(owners("lint/conformance/LiteralPin.test.ts")).toEqual(["conformance lint"])
  expect(owners("e2e/site/landing-start.spec.ts")).toEqual(["Playwright site"])
  expect(owners("e2e/real/chat-tools.spec.ts")).toEqual(["Playwright real"])
  expect(owners("e2e/real/models.spec.ts")).toEqual(["Playwright real"])
  // The real tier's coverage gate is its own source, tested by Bun rather than
  // driven by Playwright, so the unit suite owns it.
  expect(owners("e2e/real/coverage/gate.test.ts")).toEqual(["unit"])
  // So is the real tier's model provider: a Bun test of the process Playwright launches.
  expect(owners("e2e/real/support/model-provider.test.ts")).toEqual(["unit"])
  expect(owners("e2e/real/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/site/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/Unassigned.spec.ts")).toEqual([])
  expect(owners("e2e/native/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/packaged/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/playwright/native/Unassigned.spec.ts")).toEqual([])
})

test("real runner ownership comes from executable argv, not prose or a different config", () => {
  expect(realRunner).toBe(true)
  expect(scripts["test:e2e:real"]).toBe("bun scripts/run-real-e2e.ts")
  expect(invokesRealPlaywright('// run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts"])')).toBe(false)
  expect(invokesRealPlaywright('run("pnpm", ["exec", "playwright", "test", "--config", "playwright.site.config.ts"])')).toBe(false)
  expect(invokesRealPlaywright('run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", ...args])')).toBe(true)
})

test("the target unit gate matches package discovery and CI executes browser OAuth", () => {
  const paths = inspectTarget('console.log(JSON.stringify(unit.attrs.runner.paths))')
  expect(paths).toEqual(bunPaths(scripts.test))
  expect(paths).toContain("scripts")
  expect(scripts["test:e2e:auth"]).toBe("bun test e2e/native/CloudAuthFragment.test.ts")
  expect(scripts["test:e2e:probes"]).toBe("bun test e2e/probes")
  expect(read("scripts/run-pr-e2e.mjs")).toContain('["run", "test:e2e:auth"]')
  expect(read("scripts/run-pr-e2e.mjs")).toContain('["run", "test:e2e:probes"]')
  expect(inspectTarget('console.log(JSON.stringify(metadata(Package.browserE2e).attrs.runner.entry.path))'))
    .toBe("scripts/run-pr-e2e.mjs")
}, 240_000)

test("the conformance lint gate matches package discovery", () => {
  expect(inspectTarget('console.log(JSON.stringify(metadata(Package.conformance).attrs.runner.paths))'))
    .toEqual(bunPaths(scripts["lint:conformance"]))
}, 240_000)

test("unit inputs include inspected sources, harnesses and configs", () => {
  const inputs: string[] = inspectTarget(`
    const paths = []
    const seen = new Set()
    const collect = async (target) => {
      if (seen.has(target)) return
      seen.add(target)
      for (const input of target.inputs) {
        if (input._tag === "Glob") paths.push(...await Input.expandGlob(${JSON.stringify(root)}, target.attrs.cwd, input))
        else if (input._tag === "File") paths.push(Input.resolvePath(target.attrs.cwd, input.path))
      }
      for (const dependency of target.dependencies) await collect(metadata(dependency))
    }
    await collect(unit)
    console.log(JSON.stringify(paths))
  `)
  for (const path of [
    "scripts/canary-restoration.ts", "scripts/run-pr-e2e.mjs", "scripts/run-real-e2e.ts", "scripts/README.md", "e2e/native/Probe.ts",
    "PACKAGE.ts", "package.json", "tsconfig.json", "vite.config.ts", "playwright.config.ts", "playwright.site.config.ts", "playwright.real.config.ts",
    "electrobun.config.ts", "hutch.config.ts", "postcss.config.js", "tailwind.config.js"
  ]) expect(inputs).toContain(`apps/app/${path}`)
  for (const path of ["package.json", "pnpm-lock.yaml", "packages/rpc/src/Cards.ts", "packages/rpc/fixtures/force/graph.json",
    "packages/smithers/ui/src/cn.ts", "packages/smithers/gateway/src/GatewayProjection.ts"])
    expect(inputs).toContain(path)
}, 240_000)

test("a script-only edit changes the unit gate's digested inputs", () => {
  // A disposable workspace uses the real target inputs and planner digest, not a
  // second hand-maintained approximation of the cache key. Never mutate this checkout.
  const result = inspectTarget(`
    import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
    import { tmpdir } from "node:os"
    import { join } from "node:path"
    const workspace = await mkdtemp(join(tmpdir(), "ui-unit-inputs-"))
    try {
      await mkdir(join(workspace, "apps/app/scripts"), { recursive: true })
      const script = join(workspace, "apps/app/scripts/canary-restoration.ts")
      await writeFile(script, "export const revision = 1")
      const digest = async () => {
        const paths = []
        for (const input of unit.inputs) {
          if (input._tag === "Glob") paths.push(...await Input.expandGlob(workspace, "apps/app", input))
          else if (input._tag === "File") paths.push(input.path.startsWith("//") ? input.path.slice(2) : "apps/app/" + input.path)
        }
        return Input.digestFiles(workspace, paths, { concurrency: 1 })
      }
      const before = await digest()
      await writeFile(script, "export const revision = 2")
      console.log(JSON.stringify({ before, after: await digest() }))
    } finally { await rm(workspace, { recursive: true, force: true }) }
  `)
  expect(result.before).not.toEqual(result.after)
}, 240_000)

test("the documented checklist entry point writes dry-run reports from either directory", () => {
  const output = mkdtempSync(join(tmpdir(), "ui-checklist-entry-"))
  try {
    for (const [directory, name] of [[root, "root"], [app, "app"]] as const) {
      const out = join(output, name)
      execFileSync("pnpm", ["run", "checklist", "--", "--dry-run", "--out", out], {
        cwd: directory, encoding: "utf8", timeout: 60_000
      })
      const report = JSON.parse(readFileSync(join(out, "launch-checklist-report.json"), "utf8"))
      expect(report.rows.length).toBeGreaterThan(0)
      expect(report.rows.every((row: { status: string }) => row.status === "skipped-dry-run")).toBe(true)
      expect(readFileSync(join(out, "launch-checklist-report.md"), "utf8")).toContain("A-1")
    }
  } finally { rmSync(output, { recursive: true, force: true }) }
}, 240_000)

test("the runbook distinguishes failed, prerequisite-skipped and probe-undecided exit codes", () => {
  const runbook = read("scripts/README.md")
  expect(runbook).toMatch(/\| `0` \|[^\n]*prerequisite/)
  expect(runbook).toMatch(/\| `1` \|[^\n]*fail/)
  expect(runbook).toMatch(/\| `2` \|[^\n]*probe-undecided/)
  expect(runbook).toContain("skipped-dry-run")
})
