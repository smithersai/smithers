import { readFileSync, writeFileSync } from "node:fs"
import { chromium } from "playwright"

const BASE = "https://canary.smithers.sh"
const PROFILE = "/tmp/round3-flow-sweep-profile"
const checklist = readFileSync("MANUAL-REVIEW-CHECKLIST.md", "utf8")
const appendix = checklist.slice(checklist.indexOf("## Appendix A"), checklist.indexOf("## Appendix B"))
const cases = [...appendix.matchAll(/\*\*(A\.\d+)\*\* `\/([^`\s]+)`(?: `([^`]+)`)*/g)].map((match) => ({
  id: match[1]!,
  name: match[2]!,
  hint: match[3] ?? ""
}))

const validArgs: Record<string, string> = {
  theme: "paper",
  send: "hello",
  browser: "https://example.com",
  "flow.create": "summarize open issues codeplanesmithers/canary-sandbox",
  "flow.repo.choose": "codeplanesmithers/canary-sandbox",
  "flow.run.stop": "missing-card",
  "flow.run.retry": "missing-card",
  "flow.run": "create-workflow codeplanesmithers/canary-sandbox",
  "card.maximize": "missing-card",
  "copy-message": "hello",
  "approval.approve": "missing-card",
  "approval.deny": "missing-card",
  "connector.add": "read",
  "connector.downgrade": "missing-connector",
  "connector.remove": "missing-connector",
  "world.select": "missing-document",
  "world.delete": "missing-document",
  "toast.dismiss": "missing-toast",
  "repos.import": "codeplanesmithers/canary-sandbox",
  "issues.list": "open codeplanesmithers/canary-sandbox",
  "issues.view": "1 codeplanesmithers/canary-sandbox",
  "issues.create": "round3-flow-sweep-probe codeplanesmithers/canary-sandbox",
  "issues.close": "1 codeplanesmithers/canary-sandbox",
  "issues.reopen": "1 codeplanesmithers/canary-sandbox",
  "issues.comment": "1 round3-flow-sweep-probe codeplanesmithers/canary-sandbox",
  "prs.list": "codeplanesmithers/canary-sandbox",
  "prs.view": "2 codeplanesmithers/canary-sandbox",
  "prs.create": "round3-flow-sweep-probe codeplanesmithers/canary-sandbox",
  "prs.land": "2 codeplanesmithers/canary-sandbox",
  "prs.review": "2 comment round3-flow-sweep-probe codeplanesmithers/canary-sandbox",
  "billing.upgrade": "pro",
  "env.view": "codeplanesmithers/canary-sandbox",
  "env.set": "ROUND3_FLOW_SWEEP=probe codeplanesmithers/canary-sandbox",
  "branches.list": "codeplanesmithers/canary-sandbox",
  "files.list": ". codeplanesmithers/canary-sandbox",
  "files.read": "README.md codeplanesmithers/canary-sandbox",
  "repos.app": "codeplanesmithers/canary-sandbox",
  "admin.allowlist.add": "round3-flow-sweep-probe",
  "admin.allowlist.remove": "round3-flow-sweep-probe",
  "admin.grant": "1 round3-flow-sweep-probe",
  "admin.grant.confirm": "missing-card",
  "admin.grant.cancel": "missing-card",
  "admin.queue.approve": "round3-flow-sweep-probe"
}

const invalidArgs: Record<string, string> = {
  theme: "not-a-theme",
  browser: "not-a-url",
  "connector.add": "invalid",
  "issues.list": "invalid-state",
  "issues.view": "nope",
  "issues.close": "nope",
  "issues.reopen": "nope",
  "issues.comment": "nope",
  "prs.view": "nope",
  "prs.land": "nope",
  "prs.review": "2 invalid",
  "env.set": "malformed",
  "debug.backend": "switch",
  "admin.grant": "nope"
}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = context.pages()[0] ?? (await context.newPage())

const session = async () =>
  page.evaluate(async () => {
    const response = await fetch("/api/auth/session")
    return { status: response.status, text: (await response.text()).slice(0, 500) }
  })

const ensureSignedIn = async (): Promise<ReturnType<typeof session> extends Promise<infer T> ? T : never> => {
  if (!page.url().startsWith(BASE)) await page.goto(BASE, { waitUntil: "domcontentloaded" })
  await page.locator("[data-flows]").first().waitFor({ timeout: 30_000 })
  let current = await session()
  if (current.text.includes("\"login\"")) return current
  const signIn = page.locator("[data-flow=\"auth.sign-in\"]").last()
  await signIn.click({ force: true })
  await page.waitForTimeout(1200)
  if (page.url().includes("github.com/login/oauth/authorize")) {
    const authorize = page.getByRole("button", { name: /authorize|continue/i }).first()
    if (await authorize.isVisible().catch(() => false)) await authorize.click()
  }
  await page.waitForURL(/canary\.smithers\.sh/, { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2500)
  current = await session().catch(() => ({ status: 0, text: "session probe unavailable" }))
  return current
}

await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(2500)

const initialBody = await page.locator("body").innerText()
const initialDataFlows = await page.locator("[data-flows]").count()
const initialDataFlow = await page.locator("[data-flow]").count()
const sessionProbeBefore = await session()
const sessionProbe = await ensureSignedIn()
const manifest = (await page.locator("[data-flows]").first().getAttribute("data-flows")) ?? ""

const attempts: Array<Record<string, unknown>> = []
for (const item of cases) {
  const good = `/${item.name}${validArgs[item.name] ? ` ${validArgs[item.name]}` : ""}`
  const bad = `/${item.name}${invalidArgs[item.name] ? ` ${invalidArgs[item.name]}` : item.hint ? "" : " unexpected"}`
  for (const [kind, command] of [["good", good], ["bad", bad]] as const) {
    if (!page.url().startsWith(BASE)) await page.goto(BASE, { waitUntil: "domcontentloaded" })
    await ensureSignedIn()
    let input = page.locator("textarea").first()
    if ((await input.count()) === 0) {
      const chat = page.locator("[data-flow=\"chat\"]").first()
      if (await chat.isVisible().catch(() => false)) await chat.click()
      await page.waitForTimeout(250)
      input = page.locator("textarea").first()
    }
    const before = (await page.locator("body").innerText()).slice(-2500)
    let error = ""
    if ((await input.count()) > 0) {
      await input.fill(command)
      await input.press("Enter")
      await page.waitForTimeout(900)
    } else error = "No text input or Smithers flow composer was present"
    const after = (await page.locator("body").innerText()).slice(-2500)
    attempts.push({
      id: item.id,
      name: item.name,
      hint: item.hint,
      kind,
      command,
      url: page.url(),
      before,
      after,
      error,
      dataFlowsCount: await page.locator("[data-flows]").count(),
      dataFlowCount: await page.locator("[data-flow]").count()
    })
  }
}

await page.goto(`${BASE}/flows`, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(1000)
const flowsRoute = {
  url: page.url(),
  body: (await page.locator("body").innerText()).slice(0, 5000),
  dataFlowsCount: await page.locator("[data-flows]").count()
}
await page.screenshot({ path: "/tmp/round3-flow-sweep-final.png", fullPage: true })
writeFileSync(
  "/tmp/round3-flow-sweep-evidence.json",
  JSON.stringify(
    {
      cases: cases.length,
      initialBody,
      initialDataFlows,
      initialDataFlow,
      sessionProbeBefore,
      sessionProbe,
      manifest,
      attempts,
      flowsRoute
    },
    null,
    2
  )
)
await context.close()
