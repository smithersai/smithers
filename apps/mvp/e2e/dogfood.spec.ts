import { expect, type Page, test, type TestInfo } from "@playwright/test"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { me, requires } from "./target"
import { github } from "./github"

// Local limitation: this journey deliberately writes the real smithersai/smithers stack and resumes its production TODO runs. Local development has synthetic people and no deployment sandbox/model/App installation; use the local todos.spec.ts for stack editing, not this destructive production loop.
//
// The dogfood loop (docs/work/dogfood-loop.md): Smithers builds Smithers on the deployment. A Member opens a real
// low-priority issue on smithersai/smithers through the app, makes two TODOs from it, the TODOs' runs open stacked pull
// requests, and Smithers reports each head's checks as `smithers/<check>` commit statuses. A person merges; this never
// does. Each test is one step of the loop and finds what the step before it made, so a step runs again without
// making a second issue or more TODOs: the repository is real.
//
// It writes to smithersai/smithers as the test account, so it runs only against a deployment told so by name:
// `E2E_DOGFOOD=smithersai/smithers` (`dogfood`, e2e/target.ts), with the test account a Member or above. It reads
// GitHub's API to check each step; `E2E_GITHUB_TOKEN`, any token that reads public repositories, lifts the anonymous
// limit of 60 calls an hour.

const REPO = "smithersai/smithers"
const ISSUE_TITLE = "platform-browser lint fails on import() type annotations"
const ISSUE_BODY = [
  "`pnpm --filter @smthrs/platform-browser lint` fails on `main`:",
  "",
  "```",
  "src/BrowserRuntime.ts",
  "  78:36  error  `import()` type annotations are forbidden  @typescript-eslint/consistent-type-imports",
  "src/internal/Engine.ts",
  "  53:36  error  `import()` type annotations are forbidden  @typescript-eslint/consistent-type-imports",
  "```",
  "",
  "Both annotate `authorize`'s parameter as `import(\"…/SharedSqlite.ts\").Service`. A top-level `import type` of `Service` fixes each.",
  "",
  "Done when the package's lint passes. Low priority: nothing depends on it.",
].join("\n")

/**
 * The two TODOs, bottom of the stack first: the fix, then its changeset, which stacks on it. Each passes the package's
 * lint on its own, so each pull request's checks go green.
 */
const TODOS = [
  {
    title: "Type platform-browser's authorize parameter with an import type",
    prompt: "`pnpm --filter @smthrs/platform-browser lint` fails: @typescript-eslint/consistent-type-imports forbids the " +
      "`import()` type annotations of `authorize`'s parameter. In packages/smithers/flows/platform-browser: in " +
      "src/BrowserRuntime.ts add `import type * as SharedSqlite from \"./SharedSqlite.ts\"` right after the " +
      "`./internal/Prepare.ts` import, and on line 78 write `SharedSqlite.Service` for `import(\"./SharedSqlite.ts\").Service`; " +
      "in src/internal/Engine.ts make line 22 `import { filename, type Service as SharedSqliteService } from " +
      "\"../SharedSqlite.ts\"`, and on line 53 write `SharedSqliteService` for `import(\"../SharedSqlite.ts\").Service`. " +
      "Change nothing else.",
  },
  {
    title: "Add the changeset for platform-browser's import type fix",
    prompt: "Add .changeset/platform-browser-type-imports.md: a patch for \"@smthrs/platform-browser\" saying that " +
      "`authorize`'s database parameter in BrowserRuntime.ts and internal/Engine.ts is typed with a top-level `import type` " +
      "instead of an `import()` type, so the package's lint passes, with no change in behavior. Change nothing else.",
  },
] as const

const started = new WeakMap<TestInfo, number>()

test.beforeEach(async ({ page }, info) => {
  started.set(info, Date.now())
  requires("dogfood", "member")
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Maya")
})

test.afterEach(async ({}, info) => {
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Maya", video: "video.webm", openedAt: 0 }])
})

/**
 * The open issue the test account opened with the loop's title, newest first; none before step 1. GitHub's issue list,
 * not its search, whose unauthenticated limit is 10 a minute.
 */
const theIssue = async (page: Page) => {
  const found = await github<ReadonlyArray<{ number: number; title: string; user: { login: string } }>>(
    page,
    `/repos/${REPO}/issues?state=open&creator=${me().login}&sort=created&direction=desc&per_page=100`,
  )
  return found.find((item) => item.title === ISSUE_TITLE)
}

test("dogfood 1, the issue: a Member opens it in the app, and it reaches GitHub as theirs", {
  annotation: { type: "summary", description: "An issue written in Smithers is opened on smithersai/smithers under the person's own account." },
}, async ({ page }) => {
  test.setTimeout(10 * 60_000)
  // Made already by an earlier run of this step: never a second one on the real repository.
  if ((await theIssue(page)) === undefined) {
    await step("Write the issue in Smithers", async () => {
      await page.goto(`/${REPO}/issues/new`)
      await page.getByLabel("Title").fill(ISSUE_TITLE)
      await page.getByLabel("Description").fill(ISSUE_BODY)
      await page.getByRole("button", { name: "Create issue" }).click()
      await expect(page).toHaveURL(new RegExp(`/${REPO}/issues$`))
    })
  }
  const issue = await step("GitHub has it, opened by the person", async () => {
    await expect.poll(() => theIssue(page), { timeout: 5 * 60_000, intervals: [15_000] }).toBeDefined()
    const found = (await theIssue(page))!
    expect(found.user.login).toBe(me().login)
    return found
  })
  await step("Its page in Smithers", async () => {
    await page.goto(`/${REPO}/issues/${issue.number}`)
    await expect(page.getByRole("heading", { name: ISSUE_TITLE })).toBeVisible({ timeout: 5 * 60_000 })
    await expect(page.getByText("consistent-type-imports").first()).toBeVisible()
  })
})

/**
 * Whether the repository's stack has a TODO titled `title`, open or closed, read once the device synced it: the tabs show
 * their counts only then, so an empty list before that never reads as "not made yet".
 */
const stackHas = async (page: Page, title: string) => {
  const stack = page.getByRole("region", { name: `${REPO} stack` })
  let found = 0
  for (const tab of ["", "?state=closed"]) {
    await page.goto(`/${REPO}/stack${tab}`)
    await expect(stack.locator(".sui-issues-filter-count").first()).toBeVisible({ timeout: 2 * 60_000 })
    found += await stack.locator("[data-slot=issues-row]", { hasText: title }).count()
  }
  return found > 0
}

test("dogfood 2, the TODOs: two made from the issue and committed, the second after the first", {
  annotation: { type: "summary", description: "One issue becomes a stack of two TODOs, each linked to it." },
}, async ({ page }) => {
  test.setTimeout(10 * 60_000)
  const issue = (await theIssue(page))!
  expect(issue, "dogfood 1 opened the issue").toBeDefined()
  const side = page.getByRole("region", { name: "TODO" })
  const stack = page.getByRole("region", { name: `${REPO} stack` })
  for (const todo of TODOS) {
    // Committed already by an earlier run of this step, and maybe settled since: the stack has it.
    if (await stackHas(page, todo.title)) continue
    await step(`Make a TODO from #${issue.number}: ${todo.title}`, async () => {
      await page.goto(`/${REPO}/issues/${issue.number}`)
      await side.getByRole("button", { name: /Make TODO/ }).click()
      await expect(page).toHaveURL(new RegExp(`/${REPO}/stack$`))
      const draft = page.getByRole("form", { name: "TODO draft" }).filter({ hasText: `#${issue.number}` }).first()
      await expect(draft).toBeVisible({ timeout: 60_000 })
      await draft.getByLabel("Title").fill(todo.title)
      await draft.getByLabel("Prompt").fill(todo.prompt)
      await draft.getByRole("button", { name: "Commit" }).click()
      await expect(stack.locator("[data-slot=issues-row]", { hasText: todo.title })).toContainText(/T\d+/, { timeout: 60_000 })
    })
  }
  await step("The issue lists both TODOs", async () => {
    await page.goto(`/${REPO}/issues/${issue.number}`)
    await expect(side.getByRole("link", { name: /^T\d+$/ })).toHaveCount(TODOS.length, { timeout: 60_000 })
  })
})

interface Pull {
  readonly number: number
  readonly draft: boolean
  readonly state: string
  readonly head: { readonly ref: string; readonly sha: string }
  readonly base: { readonly ref: string }
}

/** The open pull request of the TODO titled `title`, from GitHub: its run opens it titled `T<n>: <title>`. */
const pullOf = async (page: Page, title: string) => {
  const pulls = await github<ReadonlyArray<Pull & { readonly title: string }>>(page, `/repos/${REPO}/pulls?state=open&per_page=100`)
  return pulls.find((pull) => new RegExp(`^T\\d+: ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(pull.title))
}

test("dogfood 3, the stacked diff: each TODO runs to a pull request, the second on the first's branch", {
  annotation: { type: "summary", description: "Two TODOs become stacked pull requests on GitHub: the second is a draft into the first's branch." },
}, async ({ page }) => {
  test.setTimeout(90 * 60_000)
  const stack = page.getByRole("region", { name: `${REPO} stack` })
  await page.goto(`/${REPO}/stack`)
  for (const todo of TODOS) {
    await step(`${todo.title}: In review`, async () => {
      await expect(stack.locator("[data-slot=issues-row]", { hasText: todo.title }))
        .toHaveAttribute("data-status", "in_review", { timeout: 40 * 60_000 })
    })
  }
  await step("On GitHub: the second pull request is a draft into the first's branch", async () => {
    const [first, second] = [await pullOf(page, TODOS[0].title), await pullOf(page, TODOS[1].title)]
    expect(first, "the first TODO's pull request").toBeDefined()
    expect(second, "the second TODO's pull request").toBeDefined()
    expect(first!.base.ref).toBe("main")
    expect(second!.base.ref).toBe(first!.head.ref)
    expect(second!.draft).toBe(true)
  })
})

test("dogfood 4, CI on our infrastructure: each head's checks pass as smithers/<check> statuses", {
  annotation: { type: "summary", description: "Smithers runs the repository's checks on each pull request's head and reports them to GitHub." },
}, async ({ page }) => {
  test.setTimeout(60 * 60_000)
  for (const todo of TODOS) {
    await step(`${todo.title}: every smithers/ check passes on its head`, async () => {
      const pull = (await pullOf(page, todo.title))!
      expect(pull, `${todo.title}'s pull request`).toBeDefined()
      const contexts = async () => {
        const status = await github<{ statuses: ReadonlyArray<{ context: string; state: string }> }>(
          page,
          `/repos/${REPO}/commits/${pull.head.sha}/status`,
        )
        return Object.fromEntries(status.statuses.filter((one) => one.context.startsWith("smithers/")).map((one) => [one.context, one.state]))
      }
      // This repository's checks (.smithers/checks) and the review, each passed on exactly this head.
      await expect.poll(contexts, { timeout: 40 * 60_000, intervals: [60_000] }).toEqual({
        "smithers/check": "success",
        "smithers/lint": "success",
        "smithers/review": "success",
      })
      await page.goto(`/${REPO}/pull/${pull.number}/checks`)
      await expect(page.getByRole("link", { name: "Checks 3/3" })).toBeVisible({ timeout: 5 * 60_000 })
    })
  }
})
