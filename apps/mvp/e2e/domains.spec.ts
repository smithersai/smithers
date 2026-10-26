import { expect, test } from "./devices"
import { requires } from "./target"

// Custom domains, end to end (decision 0039, docs/features/domains.md): the real app, ChatApi, the `domain/Verify` flow
// and its verification poll on the `FlowExecution` Durable Object, Postgres and Electric. Under `alchemy dev` the
// provider is `Dns` (no `DOMAINS_PROVIDER` set), which looks the CNAME up over DNS-over-HTTPS: a name under the
// reserved `.example` top-level domain never has one, so the domain stays pending verification, as a real one does
// until its owner adds the record. A Maintainer adds it from the repository's Settings, sees the record to add and
// the state, and removes it; a Member sees neither the Settings link nor the section. Local development's people
// (`requires("devPeople")`) sign the two in.

/** The repository sign-in reads roles on: the dev server's `GITHUB_REPOSITORY`. */
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "smithersai/smithers"

/** A domain no DNS answers for, its own per run so runs never meet. */
const hostname = () => `docs-${Date.now().toString(36)}.vibelang-e2e.example`

/** The flow starts, its first check runs and Electric delivers the row. */
const SYNCED_WITHIN = 60_000

test.describe("custom domains", () => {
  test("maintainer: adds a domain, sees the DNS record and Pending verification, then removes it", {
    annotation: {
      type: "summary",
      description: "A Maintainer adds a domain in Settings and gets its CNAME record; it waits for DNS, then is removed.",
    },
  }, async ({ devices }) => {
    requires("devPeople")
    test.setTimeout(180_000)
    const [m] = await devices.openAs("maintainer", "Maintainer")
    const page = m.page
    const domain = hostname()
    const section = page.getByRole("region", { name: "Domains" })
    const card = section.getByRole("region", { name: domain })

    await test.step("Open the repository's Settings", async () => {
      await page.goto(`/${REPOSITORY}`)
      await page.locator("header.repo-header").getByRole("link", { name: "Settings" }).click({ timeout: 30_000 })
      await expect(page.getByRole("main", { name: "Settings" })).toBeVisible()
      await expect(section).toBeVisible()
    })

    await test.step("Add the domain", async () => {
      await section.getByLabel("Domain", { exact: true }).fill(domain)
      await section.getByRole("button", { name: "Add", exact: true }).click()
      await expect(card).toBeVisible({ timeout: SYNCED_WITHIN })
    })

    await test.step("The CNAME record to add, and Pending verification", async () => {
      await expect(card.getByText("Pending verification")).toBeVisible()
      await expect(card.getByText("Certificate · Unmanaged")).toBeVisible()
      const records = card.getByRole("table", { name: "DNS records" })
      const cname = records.getByRole("row").filter({ hasText: "CNAME" })
      await expect(cname.getByRole("cell").nth(1)).toHaveText(domain)
      await expect(cname.getByRole("button", { name: "Copy CNAME Value" })).toBeVisible()
    })

    await test.step("Refresh checks the DNS again", async () => {
      await card.getByRole("button", { name: "Refresh" }).click()
      await expect(card.getByRole("status")).toHaveCount(0, { timeout: SYNCED_WITHIN })
      await expect(card.getByText("Pending verification")).toBeVisible()
    })

    await test.step("Remove the domain", async () => {
      await card.getByRole("button", { name: "Remove" }).click()
      await expect(card).toHaveCount(0, { timeout: SYNCED_WITHIN })
    })
  })

  test("member: no Settings link and no Domains section", {
    annotation: { type: "summary", description: "A Member never sees a repository's domains, not even its Settings link." },
  }, async ({ devices }) => {
    requires("devPeople")
    const [t] = await devices.openAs("teammate", "Member")
    const page = t.page

    await test.step("The repository's header has no Settings link", async () => {
      await page.goto(`/${REPOSITORY}`)
      const header = page.locator("header.repo-header")
      // A repository's page can take a while to open on a busy dev server.
      await expect(header.getByRole("link", { name: "Issues" })).toBeVisible({ timeout: 30_000 })
      await expect(header.getByRole("link", { name: "Settings" })).toHaveCount(0)
    })

    await test.step("Its Settings page shows no Domains section, and ChatApi sends no rows", async () => {
      await page.goto(`/${REPOSITORY}/settings`)
      // A full page load boots the app again, which takes seconds on a busy dev server.
      await expect(page.getByRole("main", { name: "Settings" })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole("region", { name: "Domains" })).toHaveCount(0)
      const repo = encodeURIComponent(`github/${REPOSITORY}`.toLowerCase())
      const shape = await page.request.get(`/api/shapes/domains?repo=${repo}&offset=-1`)
      expect(shape.status()).toBe(200)
      expect((await shape.json() as ReadonlyArray<{ readonly headers?: { readonly operation?: string } }>)
        .filter((message) => message.headers?.operation === "insert")).toEqual([])
    })
  })
})
