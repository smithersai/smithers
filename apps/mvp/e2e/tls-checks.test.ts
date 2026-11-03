import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, test } from "vitest"

// A context that skips TLS checks hands whatever it carries to anyone who can answer for the host. Only
// playwright.config.ts decides, from where the app is. This reads the sources, but for the files in STATES_THEM, for a file deciding for itself: each
// forwards the project's value, as a fixture or through `testInfo`, or says `false`, and nothing else counts, gated or not.
// It reads source, so it holds what files say, not what a run does. A run on this machine skips checks everywhere it goes.

const APP = new URL("..", import.meta.url).pathname
const ROOTS = ["e2e", "ops"]
/** These state the forms to refuse, or drive them. */
const STATES_THEM = new Set(["e2e/tls-checks.test.ts", "e2e/runner.test.ts", "ops/tls.test.ts", "ops/work-links/link.test.ts", "ops/deploy-smoke/run.test.ts"])
const FORWARD = String.raw`(?:test\.info\(\)|testInfo)\.project\.use\.ignoreHTTPSErrors`
/** These take the option as Playwright's fixture and pass it on, the only way to name it bare. */
const TAKE_FIXTURE = new Set(["e2e/fixtures.ts", "e2e/devices.ts", "e2e/flow-editor-storage.spec.ts", "e2e/browser-isolation.spec.ts"])
/** What may follow a whole value: the end of its property, never more of an expression. */
const ENDS = String.raw`\s*[,})]`
const VALUE = new RegExp(String.raw`^\s*:\s*(?:${FORWARD}|false)${ENDS}`)
const SHORTHAND = new RegExp(`^${ENDS}`)
const READ = new RegExp(`^${ENDS}`)
const RUNNER_SWITCH = 'NODE_TLS_REJECT_UNAUTHORIZED: new URL(url).hostname === "localhost" ? "0" : "1"'

/** Every way in `source` to turn certificate checks off, other than the forms allowed above. */
const overrides = (source: string, takesFixture = false) => {
  const found: Array<string> = []
  const line = (index: number) => source.slice(index, index + 70).split("\n")[0]!
  for (const { index } of source.matchAll(/ignoreHTTPSErrors/g)) {
    const before = source.slice(Math.max(0, index - 13), index)
    const after = source.slice(index + "ignoreHTTPSErrors".length)
    if (before.endsWith(".project.use.") ? READ.test(after) : !/[."'`[]$/.test(before) && ((takesFixture && SHORTHAND.test(after)) || VALUE.test(after))) continue
    found.push(line(index))
  }
  for (const { index } of source.matchAll(/rejectUnauthorized/g)) {
    if (!new RegExp(String.raw`^rejectUnauthorized: !onThisMachine\(baseURL\)${ENDS}`).test(source.slice(index))) found.push(line(index))
  }
  for (const { index } of source.matchAll(/NODE_TLS_REJECT_UNAUTHORIZED/g)) {
    if (!source.startsWith(RUNNER_SWITCH, index) && !source.startsWith('NODE_TLS_REJECT_UNAUTHORIZED === "0"', index)) found.push(line(index))
  }
  for (const { index } of source.matchAll(/ignore-certificate-errors/g)) found.push(line(index))
  return found
}

const sources = (directory: string): Array<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`${path} is a link this scan wouldn't follow`)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.(?:[cm]?[jt]sx?|vibe)$/.test(entry.name) ? [path] : []
  })

const scanned = ROOTS.flatMap((root) => sources(join(APP, root))).map((path) => relative(APP, path))

test("forwarding the project's value or saying false passes", () => {
  for (const allowed of [
    "newContext({ ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors })",
    "persistent({\n  ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors,\n})",
    "newContext({ ignoreHTTPSErrors: false })",
    "forward({ rejectUnauthorized: !onThisMachine(baseURL), x })",
    'if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw x',
    `({ ${RUNNER_SWITCH} })`,
  ]) expect(overrides(allowed), allowed).toEqual([])
  for (const allowed of ["newContext({ baseURL, ignoreHTTPSErrors, storageState })", "async ({ baseURL, ignoreHTTPSErrors }) => {}"]) {
    expect(overrides(allowed, true), allowed).toEqual([])
  }
})

test("every value a file chooses for itself fails, in every form", () => {
  for (const refused of [
    "newContext({ storageState, ignoreHTTPSErrors: true })",
    "newContext({ ignoreHTTPSErrors: onThisMachine(baseURL) })",
    'newContext({ ignoreHTTPSErrors: target === "local" })',
    "newContext({ ignoreHTTPSErrors:\n true })",
    "newContext({ ignoreHTTPSErrors: false\n || true })",
    "options.ignoreHTTPSErrors = true",
    'newContext({ "ignoreHTTPSErrors": true })',
    "options['ignoreHTTPSErrors'] = true",
    "const ignoreHTTPSErrors = true",
    "newContext({ ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors || true })",
    "testInfo.project.use.ignoreHTTPSErrors = true",
    "https.request({ rejectUnauthorized: false })",
    "https.request({ rejectUnauthorized: !secure })",
    "https.request({ rejectUnauthorized: !onThisMachine(baseURL) && false })",
    '({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })',
    '({ NODE_TLS_REJECT_UNAUTHORIZED: local ? "0" : "1" })',
    'launch({ args: ["--ignore-certificate-errors"] })',
  ]) expect(overrides(refused).length, refused).toBeGreaterThan(0)
  expect(overrides("a({ ignoreHTTPSErrors, b }); c({ ignoreHTTPSErrors: true })", true)).toHaveLength(1)
  expect(overrides("const open = (ignoreHTTPSErrors) => browser.newContext({ ignoreHTTPSErrors })").length).toBeGreaterThan(0)
})

test("the scan reads the real files, by real directories", () => {
  for (const root of ROOTS) expect(lstatSync(join(APP, root)).isSymbolicLink(), root).toBe(false)
  expect(scanned.length).toBeGreaterThan(100)
  expect(scanned).toEqual(expect.arrayContaining(["e2e/runner.ts", "e2e/fixtures.ts", "e2e/deployment/sign-in.setup.ts", "ops/work-links/link.mjs", "ops/deploy-smoke/run.ts"]))
  for (const each of STATES_THEM) expect(scanned, each).toContain(each)
})

test("no file under e2e/ or ops/ chooses for itself", () => {
  const found = scanned.filter((path) => !STATES_THEM.has(path)).flatMap((path) => overrides(readFileSync(join(APP, path), "utf8"), TAKE_FIXTURE.has(path)).map((use) => `${path}: ${use}`))
  expect(found).toEqual([])
})

test("every ops/ file reaching a network refuses TLS checks turned off", () => {
  const code = scanned.filter((path) => path.startsWith("ops/") && !path.includes(".test."))
  const reaching = code.filter((path) => /\b(?:fetch|clientOf|neonUri|findProject|Database\.layer)\s*\(/.test(readFileSync(join(APP, path), "utf8")))
  expect(reaching).toEqual(expect.arrayContaining(["ops/deploy-smoke/run.ts", "ops/work-links/link.mjs", "ops/issues/file.mjs", "ops/role-age/expire.ts"]))
  expect(reaching.filter((path) => !/^\s*refuseUncheckedTls\((?:process\.)?env\)$/m.test(readFileSync(join(APP, path), "utf8")))).toEqual([])
})

test("the one decision is the config's: on this machine only, and no project replaces it", () => {
  const config = readFileSync(join(APP, "playwright.config.ts"), "utf8")
  expect(config).toMatch(/^const devCertificate = onThisMachine\(baseURL\)$/m)
  const code = config.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
  expect(code.match(/ignoreHTTPSErrors/g), "shorthand would add a use the next line can't see").toHaveLength(2)
  expect([...config.matchAll(/["'`]?ignoreHTTPSErrors["'`]?\s*:\s*([^,\n}]+)/g)].map((match) => match[1]!.trim())).toEqual(["devCertificate", "devCertificate"])
  expect(config.match(/ignore-certificate-errors/g)).toHaveLength(1)
  expect(config).toContain('launchOptions: { args: devCertificate ? ["--ignore-certificate-errors"] : [] }')
  expect(config).toMatch(/process\.env\.NODE_TLS_REJECT_UNAUTHORIZED === "0"\) \{\n\s*if \(!devCertificate\) throw new Error/)
})
