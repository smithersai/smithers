// A machine token on a deployment (docs/features/machine-tokens.md): an agent's token files an issue on the sandbox
// repository through the App, the App's bot is its author, and a person-only act with the same token is refused.
//
//   E2E_PROD_URL=https://smithers.sh node e2e/prod.mjs e2e/machine-token.spec.ts --project=deployment
//
// The token comes from `E2E_MACHINE_TOKEN_FILE`, issued for the sandbox repository by ops/machine-token/issue.ts. The
// spec skips without it. It never prints the token.
import { readFileSync } from "node:fs"
import { expect, test } from "./fixtures"
import { baseURL, requires } from "./target"

requires("githubScratch")

const repo = process.env.E2E_ISSUES_REPOSITORY ?? ""
const file = process.env.E2E_MACHINE_TOKEN_FILE
test.skip(file === undefined, "needs E2E_MACHINE_TOKEN_FILE, issued by ops/machine-token/issue.ts")
const headers = () => ({ authorization: `Bearer ${readFileSync(file!, "utf8").trim()}`, "content-type": "application/json" })

test("an agent token files an issue as the App, and a person-only act with it is refused", async ({ request, playwright }) => {
  test.setTimeout(5 * 60_000)
  // A context with no cookie, so only the token speaks. `request` is the test person's, used only to read the list.
  const bare = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } })
  const writes = `${baseURL}/api/repos/${repo}/writes`
  const writeId = crypto.randomUUID()
  const title = `Machine token proof ${writeId.slice(0, 8)}`
  const made = await bare.post(writes, { headers: headers(), data: { writeId, op: "issue/create", title, body: "Filed by the machine-token e2e." } })
  expect(made.status()).toBe(202)

  let settled: { status: string; failure: string | null; number: number | null } = { status: "pending", failure: null, number: null }
  await expect.poll(async () => {
    const response = await bare.get(`${writes}/${writeId}`, { headers: headers() })
    expect(response.ok()).toBe(true)
    settled = await response.json()
    return settled.status
  }, { timeout: 4 * 60_000, intervals: [2000] }).not.toBe("pending")
  expect(settled.status, `machine write status=${settled.status} failure=${settled.failure}`).toBe("done")
  const { number } = settled

  // The author is the App's bot.
  // Read as the test person, whose session the fixture holds: the issue list takes no machine token.
  const listed = await request.get(`${baseURL}/api/repos/${repo}/issues?q=${encodeURIComponent(`#${number}`)}`)
  expect(listed.ok()).toBe(true)
  const row = (await listed.json()).issues.find((candidate: { number: number }) => candidate.number === number)
  expect(row.author.login).toMatch(/\[bot\]$/)

  // Sent again, it is the same write.
  const again = await bare.post(writes, { headers: headers(), data: { writeId, op: "issue/create", title, body: "Filed by the machine-token e2e." } })
  expect(again.status()).toBe(200)

  // Person-only acts with the same token: refused, and nothing made.
  const triage = await bare.post(writes, { headers: headers(), data: { writeId: crypto.randomUUID(), op: "issue/triage", number, decision: "accept" } })
  expect(triage.status()).toBe(400)
  const commit = await bare.post(`${baseURL}/api/repos/${repo}/stack`, { headers: headers(), data: { op: "todo/commit", number } })
  expect([401, 403]).toContain(commit.status())
  // To the session route, with no cookie, the token is no one.
  const session = await (await bare.get(`${baseURL}/api/auth/session`, { headers: headers() })).json()
  expect(session.signedIn).toBe(false)
  await bare.dispose()
})
